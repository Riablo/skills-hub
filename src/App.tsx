import { Channel } from "mygo-runtime";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Hub, type Installed, type Skill, type State, type Target, type TargetStatus } from "./mygo";

// ---- Helpers ----

type Statuses = Record<string, TargetStatus | undefined>;

const STATE_LABEL: Record<string, string> = {
  linked: "已链接",
  synced: "已同步",
  outdated: "可更新",
  conflict: "同名冲突",
  foreign: "外部",
};

const STATE_STYLE: Record<string, string> = {
  linked: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  synced: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  outdated: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  conflict: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  foreign: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
};

function targetLabel(t: Target): string {
  const name = t.global ? "全局" : t.name;
  return t.host ? `${t.host}:${name}` : name;
}

function targetPath(t: Target, home: string): string {
  if (t.global) return t.host ? "~" : home;
  return t.path;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Groups skills by their group, keeping the order they come in. */
function groupSkills(skills: Skill[]): [string, Skill[]][] {
  const groups = new Map<string, Skill[]>();
  for (const s of skills) {
    const list = groups.get(s.group);
    if (list) list.push(s);
    else groups.set(s.group, [s]);
  }
  return [...groups.entries()];
}

function matches(s: Skill, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${s.name} ${s.description} ${s.group}`.toLowerCase().includes(q);
}

function toggled<T>(set: Set<T>, items: T[], on: boolean): Set<T> {
  const next = new Set(set);
  for (const it of items) {
    if (on) next.add(it);
    else next.delete(it);
  }
  return next;
}

// ---- Small components ----

function Dialog(props: { title: string; onClose?: () => void; width?: string; children: ReactNode; footer?: ReactNode }) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6" onMouseDown={() => onClose?.()}>
      <div
        className={`flex max-h-full ${props.width ?? "w-[480px]"} flex-col rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5 pb-2 text-[14px] font-semibold">{props.title}</div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-1">{props.children}</div>
        <div className="flex items-center justify-end gap-2 px-4 pt-2 pb-3.5">{props.footer}</div>
      </div>
    </div>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <div className="mb-1 text-[12px] text-zinc-500 dark:text-zinc-400">{props.label}</div>
      {props.children}
      {props.hint && <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">{props.hint}</div>}
    </label>
  );
}

function Check(props: { checked: boolean; partial?: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.partial && !props.checked;
  }, [props.partial, props.checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="size-3.5 shrink-0 accent-blue-600"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${STATE_STYLE[state] ?? ""}`}>{STATE_LABEL[state] ?? state}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" className={`size-3 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TRIGGER_LABEL: Record<string, string> = { auto: "自动", manual: "手动", mixed: "部分手动" };

const TRIGGER_STYLE: Record<string, string> = {
  // Outlined, to tell them from the filled badges of where a skill is installed.
  auto: "border border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400",
  manual: "border border-pink-400 bg-pink-50 text-pink-700 dark:border-pink-500/60 dark:bg-pink-500/15 dark:text-pink-300",
  mixed: "border border-dashed border-pink-400 text-pink-700 dark:border-pink-500/60 dark:text-pink-300",
};

/**
 * Shows whether agents may load the skill on their own, and lets the user
 * pin it to manual or auto. The pin is kept across updates of the skill.
 */
function TriggerSelect(props: { skill: Skill; onChange: (mode: string) => void }) {
  const s = props.skill;
  const title = [
    `Claude Code：${TRIGGER_LABEL[s.claude]}`,
    `Codex：${TRIGGER_LABEL[s.codex]}`,
    s.override ? `你已固定为${TRIGGER_LABEL[s.override]}，更新后仍会保持（作者默认：${TRIGGER_LABEL[s.authorTrigger]}）` : "点击可固定为手动或自动",
  ].join("\n");
  return (
    <span className={`badge relative ${TRIGGER_STYLE[s.trigger] ?? ""} ${s.override ? "font-semibold" : ""}`} title={title}>
      {TRIGGER_LABEL[s.trigger] ?? s.trigger}
      {s.override ? " · 已固定" : ""}
      <select
        className="absolute inset-0 cursor-pointer opacity-0"
        value={s.override}
        onChange={(e) => props.onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">跟随作者（{TRIGGER_LABEL[s.authorTrigger]}）</option>
        <option value="manual">固定为手动</option>
        <option value="auto">固定为自动</option>
      </select>
    </span>
  );
}

// ---- Skill picker: grouped, searchable checklist ----

function SkillPicker(props: {
  skills: Skill[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** State of each skill in the target being installed to. */
  installed?: Map<string, Installed>;
}) {
  const [query, setQuery] = useState("");
  const groups = groupSkills(props.skills.filter((s) => !s.conflict && matches(s, query)));
  return (
    <div>
      <input className="input mb-2" placeholder="搜索技能…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <div className="h-[360px] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-700">
        {groups.length === 0 && <div className="p-6 text-center text-zinc-400">没有技能</div>}
        {groups.map(([group, list]) => {
          const names = list.map((s) => s.name);
          const picked = names.filter((n) => props.selected.has(n)).length;
          return (
            <div key={group}>
              <label className="sticky top-0 flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-2.5 py-1.5 font-medium dark:border-zinc-700 dark:bg-zinc-800">
                <Check
                  checked={picked === names.length}
                  partial={picked > 0}
                  onChange={(on) => props.onChange(toggled(props.selected, names, on))}
                />
                <span className="truncate">{group}</span>
                <span className="text-zinc-400">{list.length}</span>
              </label>
              {list.map((s) => {
                const state = props.installed?.get(s.name)?.state;
                return (
                  <label key={s.name} className="flex items-center gap-2 px-2.5 py-1 pl-6 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                    <Check checked={props.selected.has(s.name)} onChange={(on) => props.onChange(toggled(props.selected, [s.name], on))} />
                    <span className="shrink-0 font-medium">{s.name}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-400">{s.description}</span>
                    {state && <StateBadge state={state} />}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- App ----

type Modal =
  | { kind: "installTo"; names: string[] }
  | { kind: "addSkills"; target: Target }
  | { kind: "storeInstall" }
  | { kind: "addProject" }
  | { kind: "addHost" }
  | { kind: "settings" }
  | { kind: "group"; names: string[]; current: string }
  | { kind: "preview"; name: string; text: string }
  | { kind: "confirm"; title: string; message: string; action: string; run: () => void };

type Task = { title: string; lines: string[]; done: boolean; error: string };

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [statuses, setStatuses] = useState<Statuses>({});
  const [scanning, setScanning] = useState<Set<string>>(new Set());
  const [view, setView] = useState<string>("skills"); // "skills" or a target id
  const [modal, setModal] = useState<Modal | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");

  const fail = useCallback((err: unknown) => setToast(errorText(err)), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const refresh = useCallback(async () => {
    const next = await Hub.state();
    setState(next);
    return next;
  }, []);

  const scan = useCallback(async (ids: string[]) => {
    setScanning((cur) => toggled(cur, ids, true));
    await Promise.all(
      ids.map(async (id) => {
        try {
          const st = await Hub.scanTarget(id);
          setStatuses((cur) => ({ ...cur, [id]: st }));
        } catch (err) {
          setStatuses((cur) => ({ ...cur, [id]: { targetId: id, error: errorText(err), items: [] } }));
        } finally {
          setScanning((cur) => toggled(cur, [id], false));
        }
      }),
    );
  }, []);

  const reload = useCallback(async () => {
    const next = await refresh();
    await scan(next.config.targets.map((t) => t.id));
  }, [refresh, scan]);

  useEffect(() => {
    reload().catch(fail);
  }, [reload, fail]);

  /** Runs an action with a status line, reporting its failure. */
  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (err) {
        fail(err);
      } finally {
        setBusy("");
      }
    },
    [fail],
  );

  /** Runs a store command, showing its output as it comes. */
  const runTask = useCallback(
    async (title: string, fn: (log: Channel<string>) => Promise<void>) => {
      setTask({ title, lines: [], done: false, error: "" });
      const log = new Channel<string>((line) => setTask((t) => t && { ...t, lines: [...t.lines, line] }));
      let error = "";
      try {
        await fn(log);
      } catch (err) {
        error = errorText(err);
      }
      setTask((t) => t && { ...t, done: true, error });
      await reload().catch(fail);
    },
    [reload, fail],
  );

  const installTo = useCallback(
    (targetIds: string[], names: string[]) =>
      run(`正在安装 ${names.length} 个技能…`, async () => {
        const errors: string[] = [];
        for (const id of targetIds) {
          try {
            await Hub.install(id, names);
          } catch (err) {
            const t = state?.config.targets.find((t) => t.id === id);
            errors.push(`${t ? targetLabel(t) : id}: ${errorText(err)}`);
          }
        }
        await scan(targetIds);
        if (errors.length) throw new Error(errors.join("\n"));
      }),
    [run, scan, state],
  );

  const uninstall = useCallback(
    (targetId: string, names: string[]) =>
      run("正在删除…", async () => {
        try {
          await Hub.uninstall(targetId, names);
        } finally {
          await scan([targetId]);
        }
      }),
    [run, scan],
  );

  if (!state) return <div className="flex h-full items-center justify-center text-zinc-400">加载中…</div>;

  const { config, skills, home } = state;
  const targets = config.targets;
  const current = targets.find((t) => t.id === view);
  const hosts = [...new Set(["", ...targets.map((t) => t.host)])];
  const groupNames = [...new Set(skills.map((s) => s.group))];

  // Targets that have copies behind the hub's version.
  const outdated = targets
    .map((t) => ({ t, names: (statuses[t.id]?.items ?? []).filter((i) => i.state === "outdated").map((i) => i.name) }))
    .filter((o) => o.names.length > 0);
  const syncAll = () =>
    run("正在同步所有项目…", async () => {
      const errors: string[] = [];
      for (const o of outdated) {
        try {
          await Hub.install(o.t.id, o.names);
        } catch (err) {
          errors.push(`${targetLabel(o.t)}: ${errorText(err)}`);
        }
      }
      await scan(outdated.map((o) => o.t.id));
      if (errors.length) throw new Error(errors.join("\n"));
    });

  const confirm = (title: string, message: string, action: string, fn: () => void) =>
    setModal({ kind: "confirm", title, message, action, run: fn });

  return (
    <div className="flex h-full text-zinc-800 dark:text-zinc-200">
      {/* Sidebar: the skills page and the list of targets */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <SideItem active={view === "skills"} onClick={() => setView("skills")} label="全部技能" count={skills.length} />
          {hosts.map((host) => (
            <div key={host} className="mt-3">
              <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-zinc-400">{host ? `远程 · ${host}` : "本机"}</div>
              {targets
                .filter((t) => t.host === host)
                .sort((a, b) => Number(b.global) - Number(a.global))
                .map((t) => {
                  const st = statuses[t.id];
                  return (
                    <SideItem
                      key={t.id}
                      active={view === t.id}
                      onClick={() => setView(t.id)}
                      label={t.global ? "全局" : t.name}
                      count={st && !st.error ? st.items.length : undefined}
                      dot={st?.error ? "bg-red-500" : st?.items.some((i) => i.state === "outdated") ? "bg-amber-500" : undefined}
                      loading={scanning.has(t.id)}
                    />
                  );
                })}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 border-t border-zinc-200 p-2 dark:border-zinc-800">
          <button className="btn justify-center" onClick={() => setModal({ kind: "addProject" })}>
            + 添加项目
          </button>
          <div className="flex gap-1.5">
            <button className="btn flex-1 justify-center" onClick={() => setModal({ kind: "addHost" })}>
              + 远程主机
            </button>
            <button className="btn justify-center" onClick={() => setModal({ kind: "settings" })}>
              设置
            </button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <TargetView
            key={current.id}
            target={current}
            home={home}
            status={statuses[current.id]}
            scanning={scanning.has(current.id)}
            onRescan={() => scan([current.id])}
            onInstall={(names) => installTo([current.id], names)}
            onUninstall={(names) =>
              confirm(
                `从「${targetLabel(current)}」删除 ${names.length} 个技能？`,
                names.join("、"),
                "删除",
                () => void uninstall(current.id, names),
              )
            }
            onAdd={() => setModal({ kind: "addSkills", target: current })}
            onChange={(t) =>
              run("正在保存…", async () => {
                await Hub.updateTarget(t);
                await refresh();
                await scan([t.id]);
              })
            }
            onRemove={() =>
              confirm(`移除「${targetLabel(current)}」？`, "只是从列表里移除，已经安装的技能文件不会被删除。", "移除", () => {
                setView("skills");
                void run("正在移除…", async () => {
                  await Hub.removeTarget(current.id);
                  await refresh();
                });
              })
            }
            onOpen={(path) => void Hub.openPath(path).catch(fail)}
          />
        ) : (
          <SkillsView
            skills={skills}
            targets={targets}
            statuses={statuses}
            outdatedCount={outdated.length}
            onSyncAll={syncAll}
            onInstallTo={(names) => setModal({ kind: "installTo", names })}
            onStoreInstall={() => setModal({ kind: "storeInstall" })}
            onStoreUpdate={(names) =>
              runTask(names.length ? `更新 ${names.length} 个技能` : "更新全部技能", (log) => Hub.storeUpdate(names, log))
            }
            onStoreRemove={(names) =>
              confirm(
                `从仓库删除 ${names.length} 个技能？`,
                `${names.join("、")}\n\n链接到全局的会随之失效；已经复制到项目里的不受影响。`,
                "删除",
                () => void runTask(`删除 ${names.length} 个技能`, (log) => Hub.storeRemove(names, log)),
              )
            }
            onGroup={(names) =>
              setModal({ kind: "group", names, current: names.length === 1 ? (config.groups[names[0]!] ?? "") : "" })
            }
            onTrigger={(names, mode) =>
              run("", async () => {
                await Hub.setTrigger(names, mode);
                await reload();
              })
            }
            onPreview={(name) =>
              void Hub.readSkill(name)
                .then((text) => setModal({ kind: "preview", name, text }))
                .catch(fail)
            }
            onOpen={(path) => void Hub.openPath(path).catch(fail)}
            onAddSource={() =>
              run("", async () => {
                const path = await Hub.pickFolder();
                if (!path) return;
                await Hub.addSource(path);
                await reload();
              })
            }
            onReload={() => run("正在刷新…", reload)}
          />
        )}
        {busy && (
          <div className="flex items-center gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-1.5 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
            <span className="size-3 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />
            {busy}
          </div>
        )}
      </main>

      {modal?.kind === "installTo" && (
        <InstallToDialog
          names={modal.names}
          targets={targets}
          statuses={statuses}
          onClose={() => setModal(null)}
          onInstall={(ids) => {
            setModal(null);
            void installTo(ids, modal.names);
          }}
        />
      )}
      {modal?.kind === "addSkills" && (
        <AddSkillsDialog
          target={modal.target}
          skills={skills}
          status={statuses[modal.target.id]}
          onClose={() => setModal(null)}
          onInstall={(names) => {
            setModal(null);
            void installTo([modal.target.id], names);
          }}
        />
      )}
      {modal?.kind === "storeInstall" && (
        <StoreInstallDialog
          groups={groupNames}
          storePath={config.storePath}
          onClose={() => setModal(null)}
          onInstall={(spec, group) => {
            setModal(null);
            void runTask("安装技能到仓库", (log) => Hub.storeInstall(spec, group, log));
          }}
        />
      )}
      {modal?.kind === "addProject" && (
        <AddProjectDialog
          hosts={hosts.filter(Boolean)}
          onClose={() => setModal(null)}
          onError={fail}
          onAdd={async (host, path, name) => {
            const t = await Hub.addProject(host, path, name);
            // A new host also gets its global skills listed.
            if (host && !targets.some((o) => o.host === host && o.global)) await Hub.addHost(host).catch(() => {});
            setModal(null);
            setView(t.id);
            await reload();
          }}
        />
      )}
      {modal?.kind === "addHost" && (
        <AddHostDialog
          onClose={() => setModal(null)}
          onError={fail}
          onAdd={async (host) => {
            const t = await Hub.addHost(host);
            setModal(null);
            setView(t.id);
            await reload();
          }}
        />
      )}
      {modal?.kind === "settings" && (
        <SettingsDialog
          state={state}
          onClose={() => setModal(null)}
          onError={fail}
          onChanged={() => reload().catch(fail)}
        />
      )}
      {modal?.kind === "group" && (
        <GroupDialog
          names={modal.names}
          current={modal.current}
          groups={groupNames}
          onClose={() => setModal(null)}
          onSave={(group) => {
            setModal(null);
            void run("", async () => {
              await Hub.setGroup(modal.names, group);
              await refresh();
            });
          }}
        />
      )}
      {modal?.kind === "preview" && (
        <Dialog
          title={`${modal.name} / SKILL.md`}
          width="w-[720px]"
          onClose={() => setModal(null)}
          footer={
            <button className="btn" onClick={() => setModal(null)}>
              关闭
            </button>
          }
        >
          <pre className="selectable font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{modal.text}</pre>
        </Dialog>
      )}
      {modal?.kind === "confirm" && (
        <Dialog
          title={modal.title}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                autoFocus
                onClick={() => {
                  setModal(null);
                  modal.run();
                }}
              >
                {modal.action}
              </button>
            </>
          }
        >
          <div className="selectable max-h-60 overflow-auto whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{modal.message}</div>
        </Dialog>
      )}

      {task && (
        <Dialog
          title={task.title}
          width="w-[720px]"
          footer={
            <>
              {!task.done && <span className="mr-auto text-zinc-400">正在运行…</span>}
              {task.done && (
                <span className={`mr-auto ${task.error ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                  {task.error || "完成"}
                </span>
              )}
              <button className="btn btn-primary" disabled={!task.done} onClick={() => setTask(null)}>
                关闭
              </button>
            </>
          }
        >
          <LogView lines={task.lines} />
        </Dialog>
      )}

      {toast && (
        <div
          className="selectable fixed right-4 bottom-4 z-50 max-w-md rounded-lg bg-red-600 px-3.5 py-2.5 whitespace-pre-wrap text-white shadow-xl"
          onClick={() => setToast("")}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function SideItem(props: { active: boolean; onClick: () => void; label: string; count?: number; dot?: string; loading?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left ${
        props.active ? "bg-blue-600 text-white" : "hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.dot && <span className={`size-1.5 rounded-full ${props.dot}`} />}
      {props.loading ? (
        <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-zinc-300 border-t-zinc-500" />
      ) : (
        props.count !== undefined && <span className={props.active ? "text-white/70" : "text-zinc-400"}>{props.count}</span>
      )}
    </button>
  );
}

function LogView({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [lines]);
  return (
    <pre
      ref={ref}
      className="selectable h-[380px] overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-200"
    >
      {lines.join("\n")}
    </pre>
  );
}

// ---- Skills page ----

function SkillsView(props: {
  skills: Skill[];
  targets: Target[];
  statuses: Statuses;
  outdatedCount: number;
  onSyncAll: () => void;
  onInstallTo: (names: string[]) => void;
  onStoreInstall: () => void;
  onStoreUpdate: (names: string[]) => void;
  onStoreRemove: (names: string[]) => void;
  onGroup: (names: string[]) => void;
  onTrigger: (names: string[], mode: string) => void;
  onPreview: (name: string) => void;
  onOpen: (path: string) => void;
  onAddSource: () => void;
  onReload: () => void;
}) {
  const { skills, targets, statuses } = props;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState(""); // "", "auto", "manual" or "pinned"

  // Where each skill is installed.
  const installedIn = useMemo(() => {
    const map = new Map<string, { target: Target; item: Installed }[]>();
    for (const target of targets) {
      for (const item of statuses[target.id]?.items ?? []) {
        if (item.state === "foreign") continue;
        const list = map.get(item.name) ?? [];
        list.push({ target, item });
        map.set(item.name, list);
      }
    }
    return map;
  }, [targets, statuses]);

  const byName = new Map(skills.filter((s) => !s.conflict).map((s) => [s.name, s]));
  const picked = [...selected].filter((n) => byName.has(n));
  const pickedStore = picked.filter((n) => byName.get(n)!.origin === "store");
  const shown = (s: Skill) =>
    matches(s, query) && (filter === "" || (filter === "pinned" ? s.override !== "" : filter === "manual" ? s.trigger !== "auto" : s.trigger === "auto"));
  const groups = groupSkills(skills.filter(shown));
  const allGroups = [...new Set(skills.map((s) => s.group))];
  const anyOpen = allGroups.some((g) => !collapsed.has(g));

  return (
    <>
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <input className="input max-w-56" placeholder="搜索技能…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} title="按触发方式筛选">
          <option value="">全部</option>
          <option value="auto">自动触发</option>
          <option value="manual">手动触发</option>
          <option value="pinned">我固定的</option>
        </select>
        <button className="btn" onClick={() => setCollapsed(anyOpen ? new Set(allGroups) : new Set())}>
          {anyOpen ? "全部收起" : "全部展开"}
        </button>
        <div className="flex-1" />
        {props.outdatedCount > 0 && (
          <button className="btn" onClick={props.onSyncAll} title="把所有项目里落后的副本更新到仓库的版本">
            同步 {props.outdatedCount} 个项目
          </button>
        )}
        <button className="btn" onClick={props.onReload}>
          刷新
        </button>
        <button className="btn" onClick={props.onAddSource} title="关联一个放着你自己写的技能的文件夹">
          关联本地文件夹
        </button>
        <button className="btn" onClick={() => props.onStoreUpdate([])} title="npx skills update">
          更新全部
        </button>
        <button className="btn btn-primary" onClick={props.onStoreInstall}>
          安装技能
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {skills.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
            <div>仓库里还没有技能</div>
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={props.onStoreInstall}>
                安装技能
              </button>
              <button className="btn" onClick={props.onAddSource}>
                关联本地文件夹
              </button>
            </div>
          </div>
        )}
        {groups.map(([group, list]) => {
          const names = list.filter((s) => !s.conflict).map((s) => s.name);
          const count = names.filter((n) => selected.has(n)).length;
          const storeNames = list.filter((s) => !s.conflict && s.origin === "store").map((s) => s.name);
          const open = !collapsed.has(group) || query.trim() !== "";
          return (
            <section key={group}>
              <div
                className="group sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 dark:border-zinc-800 dark:bg-zinc-900"
                onClick={() => setCollapsed(toggled(collapsed, [group], open))}
              >
                <Check
                  checked={names.length > 0 && count === names.length}
                  partial={count > 0}
                  onChange={(on) => setSelected(toggled(selected, names, on))}
                />
                <Chevron open={open} />
                <span className="truncate font-semibold">{group}</span>
                <span className="text-zinc-400">{list.length}</span>
                <div className="flex-1" />
                <button
                  className="btn btn-ghost h-6 opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onGroup(names);
                  }}
                >
                  重命名分组
                </button>
                {storeNames.length > 0 && (
                  <button
                    className="btn btn-ghost btn-danger h-6 opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onStoreRemove(storeNames);
                    }}
                  >
                    删除整组
                  </button>
                )}
                <button
                  className="btn h-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onInstallTo(names);
                  }}
                >
                  安装整组…
                </button>
              </div>
              {open &&
                list.map((s) => (
                  <div
                    key={s.path}
                    className="group flex min-h-9 items-center gap-2 border-b border-zinc-100 px-4 py-1 pl-9 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
                  >
                    <Check
                      checked={selected.has(s.name) && !s.conflict}
                      disabled={s.conflict}
                      onChange={(on) => setSelected(toggled(selected, [s.name], on))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="selectable truncate font-medium">{s.name}</span>
                        {s.origin === "local" && (
                          <span className="badge bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" title={s.path}>
                            本地
                          </span>
                        )}
                        {s.conflict ? (
                          <span className="badge bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" title="已有同名技能，这个无法安装">
                            重名
                          </span>
                        ) : (
                          <TriggerSelect skill={s} onChange={(mode) => props.onTrigger([s.name], mode)} />
                        )}
                        {(installedIn.get(s.name) ?? []).map(({ target, item }) => (
                          <span
                            key={target.id}
                            className={`badge ${STATE_STYLE[item.state] ?? ""}`}
                            title={`${targetLabel(target)} · ${STATE_LABEL[item.state] ?? item.state}`}
                          >
                            {targetLabel(target)}
                          </span>
                        ))}
                      </div>
                      <div className="truncate text-[12px] text-zinc-400" title={s.description}>
                        {s.description || "—"}
                      </div>
                    </div>
                    <div className="hidden shrink-0 items-center gap-1 group-hover:flex">
                      <button className="btn btn-ghost h-6" onClick={() => props.onPreview(s.name)}>
                        查看
                      </button>
                      <button className="btn btn-ghost h-6" onClick={() => props.onOpen(s.path)}>
                        打开
                      </button>
                      {!s.conflict && (
                        <button className="btn btn-ghost h-6" onClick={() => props.onGroup([s.name])}>
                          分组
                        </button>
                      )}
                      {s.origin === "store" && (
                        <>
                          <button className="btn btn-ghost h-6" onClick={() => props.onStoreUpdate([s.name])}>
                            更新
                          </button>
                          <button className="btn btn-ghost btn-danger h-6" onClick={() => props.onStoreRemove([s.name])}>
                            删除
                          </button>
                        </>
                      )}
                    </div>
                    <button className="btn h-6" disabled={s.conflict} onClick={() => props.onInstallTo([s.name])}>
                      安装到…
                    </button>
                  </div>
                ))}
            </section>
          );
        })}
      </div>

      {picked.length > 0 && (
        <footer className="flex items-center gap-2 border-t border-zinc-200 bg-blue-50 px-4 py-2 dark:border-zinc-800 dark:bg-blue-500/10">
          <span className="font-medium">已选 {picked.length} 个技能</span>
          <div className="flex-1" />
          <button className="btn" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <select
            className="input w-auto"
            value=""
            onChange={(e) => props.onTrigger(picked, e.target.value === "default" ? "" : e.target.value)}
            title="所选技能在 Claude Code 和 Codex 里的触发方式"
          >
            <option value="" disabled>
              触发方式…
            </option>
            <option value="manual">固定为手动</option>
            <option value="auto">固定为自动</option>
            <option value="default">跟随作者</option>
          </select>
          <button className="btn" onClick={() => props.onGroup(picked)}>
            设置分组…
          </button>
          {pickedStore.length > 0 && (
            <>
              <button className="btn" onClick={() => props.onStoreUpdate(pickedStore)}>
                更新
              </button>
              <button className="btn btn-danger" onClick={() => props.onStoreRemove(pickedStore)}>
                从仓库删除
              </button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => props.onInstallTo(picked)}>
            安装到…
          </button>
        </footer>
      )}
    </>
  );
}

// ---- Target page ----

function placement(it: Installed): string {
  const word: Record<string, string> = { link: "链接", copy: "副本", alias: "→ .agents" };
  const parts: string[] = [];
  if (it.agents) parts.push(`.agents ${word[it.agents] ?? it.agents}`);
  if (it.claude) parts.push(`.claude ${word[it.claude] ?? it.claude}`);
  return parts.join(" · ");
}

function TargetView(props: {
  target: Target;
  home: string;
  status: TargetStatus | undefined;
  scanning: boolean;
  onRescan: () => void;
  onInstall: (names: string[]) => void;
  onUninstall: (names: string[]) => void;
  onAdd: () => void;
  onChange: (t: Target) => void;
  onRemove: () => void;
  onOpen: (path: string) => void;
}) {
  const { target: t, status } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const items = status?.items ?? [];
  const names = items.map((i) => i.name);
  const picked = names.filter((n) => selected.has(n));
  const outdated = items.filter((i) => i.state === "outdated").map((i) => i.name);
  const managed = items.filter((i) => i.state !== "foreign" && i.state !== "conflict").map((i) => i.name);
  const path = targetPath(t, props.home);

  return (
    <>
      <header className="border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{targetLabel(t)}</div>
            <div className="selectable truncate text-[12px] text-zinc-400">
              {t.host ? `ssh ${t.host} · ` : ""}
              {path}
            </div>
          </div>
          {!t.host && (
            <button className="btn" onClick={() => props.onOpen(path)}>
              打开目录
            </button>
          )}
          <button className="btn" onClick={props.onRescan} disabled={props.scanning}>
            {props.scanning ? "扫描中…" : "刷新"}
          </button>
          {t.id !== "local-global" && (
            <button className="btn btn-danger" onClick={props.onRemove}>
              移除
            </button>
          )}
          <button className="btn btn-primary" onClick={props.onAdd}>
            添加技能…
          </button>
        </div>
        <div className="mt-2 flex items-center gap-4 text-[12px] text-zinc-500 dark:text-zinc-400">
          <label className="flex items-center gap-1.5">
            安装方式
            <select
              className="input h-6 w-auto"
              value={t.mode}
              disabled={!!t.host}
              title={t.host ? "远程主机只能复制" : ""}
              onChange={(e) => props.onChange({ ...t, mode: e.target.value })}
            >
              <option value="link">软链接</option>
              <option value="copy">复制</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <Check checked={t.agents} onChange={(on) => props.onChange({ ...t, agents: on })} />
            .agents/skills
          </label>
          <label className="flex items-center gap-1.5">
            <Check checked={t.claude} onChange={(on) => props.onChange({ ...t, claude: on })} />
            .claude/skills（Claude Code）
          </label>
          <div className="flex-1" />
          {managed.length > 0 && (
            <button className="btn h-6" onClick={() => props.onInstall(managed)} title="按当前的安装方式和目录重新安装所有来自仓库的技能">
              全部重装
            </button>
          )}
          {outdated.length > 0 && (
            <button className="btn btn-primary h-6" onClick={() => props.onInstall(outdated)}>
              同步 {outdated.length} 个更新
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {status?.error && (
          <div className="selectable m-4 rounded-md bg-red-50 p-3 whitespace-pre-wrap text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {status.error}
          </div>
        )}
        {!status && <div className="p-10 text-center text-zinc-400">扫描中…</div>}
        {status && !status.error && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-400">
            <div>这里还没有安装技能</div>
            <button className="btn btn-primary" onClick={props.onAdd}>
              添加技能…
            </button>
          </div>
        )}
        {items.length > 0 && (
          <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            <Check
              checked={picked.length === names.length}
              partial={picked.length > 0}
              onChange={(on) => setSelected(on ? new Set(names) : new Set())}
            />
            <span>{picked.length > 0 ? `已选 ${picked.length} 个` : `${items.length} 个技能`}</span>
            <div className="flex-1" />
            {picked.length > 0 && (
              <button className="btn btn-danger h-6" onClick={() => props.onUninstall(picked)}>
                删除所选
              </button>
            )}
          </div>
        )}
        {items.map((it) => (
          <div
            key={it.name}
            className="group flex h-9 items-center gap-2 border-b border-zinc-100 px-4 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/40"
          >
            <Check checked={selected.has(it.name)} onChange={(on) => setSelected(toggled(selected, [it.name], on))} />
            <span className="selectable shrink-0 font-medium">{it.name}</span>
            <span className={`badge ${TRIGGER_STYLE[it.trigger] ?? ""}`} title="这份已安装的技能在 Claude Code 和 Codex 里的触发方式">
              {TRIGGER_LABEL[it.trigger] ?? it.trigger}
            </span>
            <StateBadge state={it.state} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-400" title={it.linkTo}>
              {placement(it)}
              {(it.state === "foreign" || it.state === "conflict") && it.linkTo ? ` · ${it.linkTo}` : ""}
            </span>
            {it.state === "outdated" && (
              <button className="btn h-6" onClick={() => props.onInstall([it.name])}>
                同步
              </button>
            )}
            {it.state === "conflict" && (
              <button className="btn h-6" onClick={() => props.onInstall([it.name])} title="用仓库里的同名技能替换它">
                用仓库的替换
              </button>
            )}
            <button className="btn btn-ghost btn-danger h-6 opacity-0 group-hover:opacity-100" onClick={() => props.onUninstall([it.name])}>
              删除
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---- Dialogs ----

function InstallToDialog(props: {
  names: string[];
  targets: Target[];
  statuses: Statuses;
  onClose: () => void;
  onInstall: (targetIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const title = props.names.length === 1 ? `安装「${props.names[0]}」到…` : `安装 ${props.names.length} 个技能到…`;
  return (
    <Dialog
      title={title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={picked.size === 0} onClick={() => props.onInstall([...picked])}>
            安装
          </button>
        </>
      }
    >
      <div className="max-h-[400px] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-700">
        {props.targets.map((t) => {
          const st = props.statuses[t.id];
          const have = new Map((st?.items ?? []).map((i) => [i.name, i.state]));
          const current = props.names.filter((n) => ["linked", "synced"].includes(have.get(n) ?? "")).length;
          return (
            <label key={t.id} className="flex h-9 items-center gap-2 border-b border-zinc-100 px-2.5 last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60">
              <Check checked={picked.has(t.id)} onChange={(on) => setPicked(toggled(picked, [t.id], on))} />
              <span className="font-medium">{targetLabel(t)}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-400">{t.global ? "" : t.path}</span>
              {st?.error ? (
                <span className="badge bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300">连接失败</span>
              ) : (
                current > 0 && (
                  <span className="text-[12px] text-zinc-400">
                    已装 {current}/{props.names.length}
                  </span>
                )
              )}
              <span className="badge bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {t.mode === "link" && !t.host ? "软链接" : "复制"}
              </span>
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}

function AddSkillsDialog(props: {
  target: Target;
  skills: Skill[];
  status: TargetStatus | undefined;
  onClose: () => void;
  onInstall: (names: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const installed = new Map((props.status?.items ?? []).map((i) => [i.name, i]));
  return (
    <Dialog
      title={`添加技能到「${targetLabel(props.target)}」`}
      width="w-[640px]"
      onClose={props.onClose}
      footer={
        <>
          <span className="mr-auto text-zinc-400">{props.target.mode === "link" && !props.target.host ? "以软链接安装" : "以复制安装"}</span>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={picked.size === 0} onClick={() => props.onInstall([...picked])}>
            安装 {picked.size || ""}
          </button>
        </>
      }
    >
      <SkillPicker skills={props.skills} selected={picked} onChange={setPicked} installed={installed} />
    </Dialog>
  );
}

function StoreInstallDialog(props: {
  groups: string[];
  storePath: string;
  onClose: () => void;
  onInstall: (spec: string, group: string) => void;
}) {
  const [spec, setSpec] = useState("");
  const [group, setGroup] = useState("");
  return (
    <Dialog
      title="安装技能到仓库"
      width="w-[560px]"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={!spec.trim()} onClick={() => props.onInstall(spec, group)}>
            安装
          </button>
        </>
      }
    >
      <Field
        label="来源"
        hint={`GitHub 仓库、URL，或直接粘贴 skills.sh 上的整条命令。可带参数，如 “owner/repo -s skill-a skill-b”。会在 ${props.storePath} 里执行 npx skills add。`}
      >
        <input
          className="input font-mono"
          placeholder="vercel-labs/agent-skills"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && spec.trim()) props.onInstall(spec, group);
          }}
          autoFocus
          spellCheck={false}
        />
      </Field>
      <Field label="分组（可选）" hint="留空则按来源仓库自动分组。">
        <input className="input" list="groups" value={group} onChange={(e) => setGroup(e.target.value)} />
        <datalist id="groups">
          {props.groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
    </Dialog>
  );
}

function HostInput(props: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    Hub.sshHosts().then(setKnown, () => {});
  }, []);
  return (
    <>
      <input
        className="input"
        list="ssh-hosts"
        placeholder="home 或 user@host"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoFocus={props.autoFocus}
        spellCheck={false}
      />
      <datalist id="ssh-hosts">
        {known.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
    </>
  );
}

function AddProjectDialog(props: {
  hosts: string[];
  onClose: () => void;
  onError: (err: unknown) => void;
  onAdd: (host: string, path: string, name: string) => Promise<void>;
}) {
  const [remote, setRemote] = useState(false);
  const [host, setHost] = useState(props.hosts[0] ?? "");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    setWorking(true);
    try {
      await props.onAdd(remote ? host : "", path, name);
    } catch (err) {
      props.onError(err);
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      title="添加项目"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={working || !path.trim() || (remote && !host.trim())} onClick={submit}>
            {working ? "检查中…" : "添加"}
          </button>
        </>
      }
    >
      <div className="mb-3 flex gap-1.5">
        <button className={`btn ${remote ? "" : "btn-primary"}`} onClick={() => setRemote(false)}>
          本机
        </button>
        <button className={`btn ${remote ? "btn-primary" : ""}`} onClick={() => setRemote(true)}>
          远程主机
        </button>
      </div>
      {remote && (
        <Field label="SSH 主机" hint="用 ssh 命令能直接连上的名字，需要免密登录。">
          <HostInput value={host} onChange={setHost} />
        </Field>
      )}
      <Field label="项目路径">
        <div className="flex gap-1.5">
          <input
            className="input font-mono"
            placeholder={remote ? "~/projects/my-app" : "/Users/me/projects/my-app"}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            spellCheck={false}
          />
          {!remote && (
            <button
              className="btn"
              onClick={() =>
                Hub.pickFolder().then((p) => {
                  if (p) setPath(p);
                }, props.onError)
              }
            >
              选择…
            </button>
          )}
        </div>
      </Field>
      <Field label="名称（可选）" hint="留空则用文件夹名。">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function AddHostDialog(props: { onClose: () => void; onError: (err: unknown) => void; onAdd: (host: string) => Promise<void> }) {
  const [host, setHost] = useState("");
  const [working, setWorking] = useState(false);
  const submit = async () => {
    setWorking(true);
    try {
      await props.onAdd(host);
    } catch (err) {
      props.onError(err);
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      title="添加远程主机"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={working || !host.trim()} onClick={submit}>
            {working ? "连接中…" : "添加"}
          </button>
        </>
      }
    >
      <Field label="SSH 主机" hint="会添加这台主机的全局技能目录（~/.agents/skills 和 ~/.claude/skills）。它的项目用「添加项目」来加。">
        <HostInput value={host} onChange={setHost} autoFocus />
      </Field>
    </Dialog>
  );
}

function GroupDialog(props: { names: string[]; current: string; groups: string[]; onClose: () => void; onSave: (group: string) => void }) {
  const [group, setGroup] = useState(props.current);
  return (
    <Dialog
      title={props.names.length === 1 ? `「${props.names[0]}」的分组` : `设置 ${props.names.length} 个技能的分组`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => props.onSave(group)}>
            保存
          </button>
        </>
      }
    >
      <Field label="分组" hint="留空则恢复默认：按来源仓库或本地文件夹分组。">
        <input
          className="input"
          list="groups"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSave(group);
          }}
          autoFocus
        />
        <datalist id="groups">
          {props.groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
    </Dialog>
  );
}

function SettingsDialog(props: { state: State; onClose: () => void; onError: (err: unknown) => void; onChanged: () => void }) {
  const { config } = props.state;
  const [store, setStore] = useState(config.storePath);
  const act = (p: Promise<unknown>) => p.then(props.onChanged, props.onError);
  return (
    <Dialog
      title="设置"
      width="w-[600px]"
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          关闭
        </button>
      }
    >
      <Field label="技能仓库" hint="技能用 npx skills add 安装到这个文件夹的 .agents/skills 里，再从这里分发出去。">
        <div className="flex gap-1.5">
          <input className="input font-mono" value={store} onChange={(e) => setStore(e.target.value)} spellCheck={false} />
          <button
            className="btn"
            onClick={() =>
              Hub.pickFolder().then((p) => {
                if (p) setStore(p);
              }, props.onError)
            }
          >
            选择…
          </button>
          <button className="btn" onClick={() => void Hub.openPath(config.storePath).catch(props.onError)}>
            打开
          </button>
          <button className="btn btn-primary" disabled={store.trim() === config.storePath} onClick={() => void act(Hub.setStorePath(store))}>
            保存
          </button>
        </div>
      </Field>
      <div className="mb-1 text-[12px] text-zinc-500 dark:text-zinc-400">本地文件夹</div>
      <div className="rounded-md border border-zinc-200 dark:border-zinc-700">
        {config.sources.length === 0 && <div className="p-3 text-center text-zinc-400">还没有关联本地文件夹</div>}
        {config.sources.map((s) => (
          <div key={s.id} className="flex h-9 items-center gap-2 border-b border-zinc-100 px-2.5 last:border-0 dark:border-zinc-800">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]">{s.path}</span>
            <span className="text-zinc-400">{props.state.skills.filter((k) => k.origin === "local" && k.source === s.path).length} 个技能</span>
            <button className="btn btn-ghost h-6" onClick={() => void Hub.openPath(s.path).catch(props.onError)}>
              打开
            </button>
            <button className="btn btn-ghost btn-danger h-6" onClick={() => void act(Hub.removeSource(s.id))}>
              取消关联
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 mb-2 flex items-center gap-2">
        <button
          className="btn"
          onClick={() =>
            void act(
              Hub.pickFolder().then((p) => {
                if (p) return Hub.addSource(p);
              }),
            )
          }
        >
          + 关联文件夹
        </button>
        <span className="text-[11px] text-zinc-400">可以是单个技能的文件夹，也可以是放着多个技能的文件夹。技能直接从原位置读取，改了立即生效。</span>
      </div>
    </Dialog>
  );
}

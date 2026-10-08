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

const TRIGGER_LABEL: Record<string, string> = { auto: "自动", manual: "手动", mixed: "部分手动" };

const GLOBAL_PATH = "~/.agents/skills · ~/.claude/skills";

function targetLabel(t: Target): string {
  const name = t.global ? "全局" : t.name;
  return t.host ? `${t.host}:${name}` : name;
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

/** Targets by machine: this one first, each with its global skills first. */
function byHost(targets: Target[]): [string, Target[]][] {
  const hosts = [...new Set(["", ...targets.map((t) => t.host)])];
  return hosts.map((host) => [host, targets.filter((t) => t.host === host).sort((a, b) => Number(b.global) - Number(a.global))]);
}

// The tile in front of a group's name: its initials on one of a few tints.
const TILES: [string, string][] = [
  ["#E4E8FF", "#2F3A9E"],
  ["#FBE9DF", "#8A3A12"],
  ["#E3F3EC", "#17603F"],
  ["#EEEBFB", "#4A3AA8"],
  ["#FCE7EF", "#8E1A4F"],
  ["#E2F1F8", "#155A75"],
];

function tile(name: string): { initials: string; bg: string; fg: string } {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = TILES[hash % TILES.length]!;
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2);
  // Two wide characters do not fit the tile.
  const wide = /[^\x00-\x7f]/.test(initials);
  return { initials: wide ? [...initials][0]! : initials.toLowerCase(), bg, fg };
}

// ---- Icons ----

const ICONS = {
  grid: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.6 3.5 2.6 5.8S9.8 12.2 8 13.8C6.2 12.2 5.4 10.3 5.4 8S6.2 3.8 8 2.2z" />
    </>
  ),
  folder: <path d="M2 4.6c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.2c.7 0 1.2.5 1.2 1.2v5.5c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.6z" />,
  plus: <path d="M8 3v10M3 8h10" />,
  sliders: (
    <>
      <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="6" cy="11.5" r="1.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 6.9A5.2 5.2 0 0 0 3.5 4.8M3 9.1a5.2 5.2 0 0 0 9.5 2.1" />
      <path d="M3.5 2.3v2.6h2.6M12.5 13.7v-2.6H9.9" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5l3 3" />
    </>
  ),
  down: <path d="M4 6l4 4 4-4" />,
  right: <path d="M6 4l4 4-4 4" />,
  fold: <path d="M5 6.5L8 3.5l3 3M5 9.5l3 3 3-3" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  tag: (
    <>
      <path d="M2.5 8.6V3.4c0-.5.4-.9.9-.9h5.2l5 5a.9.9 0 0 1 0 1.3l-4.5 4.5a.9.9 0 0 1-1.3 0l-5-5z" />
      <circle cx="5.6" cy="5.6" r="0.9" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.3 4.5V3h3.4v1.5M4.3 4.5l.6 8.2c0 .4.4.8.8.8h4.6c.4 0 .8-.4.8-.8l.6-8.2" />,
  link: <path d="M6.7 9.3l2.6-2.6M5.9 7L4.4 8.5a2.2 2.2 0 0 0 3.1 3.1L9 10.1M10.100 9l1.5-1.5a2.2 2.2 0 0 0-3.1-3.1L7 5.9" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4.100c0-.9-.7-1.600-1.600-1.600H4.100c-.9 0-1.600.7-1.600 1.600v4.800c0 .9.7 1.600 1.600 1.600h1.400" />
    </>
  ),
  check: <path d="M3.5 8.4l3 3 6-6.400" />,
  up: <path d="M8 13V3.500M4 7.300l4-4 4 4" />,
  bolt: <path d="M9 2L3.800 9h3.700L7 14l5.200-7H8.500L9 2z" />,
  slash: <path d="M10.200 2.500L5.800 13.500" />,
  dashed: <circle cx="8" cy="8" r="5.5" strokeDasharray="2.6 2.2" />,
  warn: <path d="M8 6v3M8 11.200v.2M8 2.500l5.800 10.300H2.200L8 2.500z" />,
} as const;

type IconName = keyof typeof ICONS;

function Icon(props: { name: IconName; size?: number; className?: string; width?: number }) {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.width ?? 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${props.className ?? ""}`}
      aria-hidden="true"
    >
      {ICONS[props.name]}
    </svg>
  );
}

// ---- Small components ----

function Dialog(props: { title: string; header?: ReactNode; onClose?: () => void; width?: string; children: ReactNode; footer?: ReactNode }) {
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
        role="dialog"
        className={`bg-card flex max-h-full ${props.width ?? "w-[500px]"} flex-col overflow-hidden rounded-[14px] shadow-[0_24px_60px_rgb(28_28_40/0.28),0_0_0_1px_rgb(28_28_40/0.08)]`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2.5 px-5 pt-5 pb-3.5">
          <h1 className="m-0 text-[16px] font-[650] tracking-[-0.01em]">{props.title}</h1>
          {props.header}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">{props.children}</div>
        <div className="border-line-soft bg-ground/60 flex items-center justify-end gap-2 border-t px-5 py-3.5">{props.footer}</div>
      </div>
    </div>
  );
}

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3.5 block">
      <div className="label mb-1.5">{props.label}</div>
      {props.children}
      {props.hint && <div className="text-muted mt-1.5 text-[12px]">{props.hint}</div>}
    </label>
  );
}

function Check(props: { checked: boolean; partial?: boolean; onChange: (on: boolean) => void; disabled?: boolean; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.partial && !props.checked;
  }, [props.partial, props.checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={props.label}
      className="m-0 size-[15px] shrink-0"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** A "more" button opening a short list of actions. */
function Menu(props: { label: string; items: { label: string; danger?: boolean; onClick: () => void }[]; bordered?: boolean }) {
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);
  if (props.items.length === 0) return null;
  return (
    <>
      <button
        aria-label={props.label}
        title={props.label}
        className={props.bordered ? "btn w-8 px-0" : "icon-btn"}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setPos(pos ? null : { right: window.innerWidth - r.right, top: r.bottom + 4 });
        }}
      >
        <Icon name="more" />
      </button>
      {pos && (
        <div
          className="border-line bg-card fixed z-30 min-w-36 rounded-[10px] border p-1 shadow-[0_12px_32px_rgb(28_28_40/0.18)]"
          style={pos}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {props.items.map((it) => (
            <button
              key={it.label}
              className={`hover:bg-fill flex h-7 w-full items-center rounded-md px-2.5 text-left whitespace-nowrap ${it.danger ? "text-danger" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setPos(null);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** How a skill is triggered: a bolt for auto, a slash for manual. */
function TriggerBadge(props: { trigger: string; suffix?: string; title?: string; children?: ReactNode }) {
  const manual = props.trigger !== "auto";
  return (
    <span
      className={`chip relative ${manual ? "bg-manual-bg text-manual" : "bg-auto-bg text-auto"} ${props.trigger === "mixed" ? "outline-manual/50 outline-1 outline-dashed" : ""}`}
      title={props.title}
    >
      <Icon name={manual ? "slash" : "bolt"} size={12} />
      {TRIGGER_LABEL[props.trigger] ?? props.trigger}
      {props.suffix}
      {props.children}
    </span>
  );
}

/**
 * The trigger of a hub skill, which the user can pin to manual or auto. The
 * pin is kept across updates of the skill.
 */
function TriggerSelect(props: { skill: Skill; onChange: (mode: string) => void }) {
  const s = props.skill;
  const title = [
    `Claude Code：${TRIGGER_LABEL[s.claude]}`,
    `Codex：${TRIGGER_LABEL[s.codex]}`,
    s.override ? `你已固定为${TRIGGER_LABEL[s.override]}，更新后仍会保持（作者默认：${TRIGGER_LABEL[s.authorTrigger]}）` : "点击可固定为手动或自动",
  ].join("\n");
  return (
    <TriggerBadge trigger={s.trigger} suffix={s.override ? " · 已固定" : ""} title={title}>
      <select
        aria-label="触发方式"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={s.override}
        onChange={(e) => props.onChange(e.target.value)}
        onClick={(e) => e.stopPropagation()}
      >
        <option value="">跟随作者（{TRIGGER_LABEL[s.authorTrigger]}）</option>
        <option value="manual">固定为手动</option>
        <option value="auto">固定为自动</option>
      </select>
    </TriggerBadge>
  );
}

const STATE_ICON: Record<string, { name: IconName; color: string }> = {
  linked: { name: "link", color: "text-accent" },
  synced: { name: "check", color: "text-ok" },
  outdated: { name: "up", color: "text-warn-dot" },
  conflict: { name: "warn", color: "text-danger" },
  foreign: { name: "dashed", color: "text-muted" },
};

function StateIcon({ state, size }: { state: string; size?: number }) {
  const icon = STATE_ICON[state] ?? STATE_ICON.foreign!;
  return <Icon name={icon.name} size={size ?? 14} width={1.7} className={icon.color} />;
}

function ModeTag({ target }: { target: Target }) {
  const link = target.mode === "link" && !target.host;
  return (
    <span className="pill">
      <Icon name={link ? "link" : "copy"} size={12} />
      {link ? "软链接" : "复制"}
    </span>
  );
}

function GroupTile({ name }: { name: string }) {
  const t = tile(name);
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold"
      style={{ background: t.bg, color: t.fg }}
    >
      {t.initials}
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
      <input className="input mb-2.5" placeholder="搜索技能…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <div className="border-line h-[380px] overflow-auto rounded-[10px] border">
        {groups.length === 0 && <div className="text-muted p-6 text-center">没有技能</div>}
        {groups.map(([group, list]) => {
          const names = list.map((s) => s.name);
          const picked = names.filter((n) => props.selected.has(n)).length;
          return (
            <div key={group}>
              <label className="border-line-soft bg-ground sticky top-0 z-10 flex h-9 items-center gap-2.5 border-b px-3">
                <Check checked={picked === names.length} partial={picked > 0} onChange={(on) => props.onChange(toggled(props.selected, names, on))} />
                <GroupTile name={group} />
                <span className="truncate font-mono text-[12px] font-semibold">{group}</span>
                <span className="text-muted">{list.length}</span>
              </label>
              {list.map((s) => {
                const state = props.installed?.get(s.name)?.state;
                return (
                  <label key={s.name} className="border-line-soft hover:bg-hover flex h-9 items-center gap-2.5 border-b px-3">
                    <Check checked={props.selected.has(s.name)} onChange={(on) => props.onChange(toggled(props.selected, [s.name], on))} />
                    <span className="shrink-0 font-mono text-[12px] font-semibold">{s.name}</span>
                    <TriggerBadge trigger={s.trigger} />
                    <span className="text-muted min-w-0 flex-1 truncate text-[12px]">{s.description}</span>
                    {state && (
                      <span className="pill">
                        <StateIcon state={state} size={12} />
                        {STATE_LABEL[state] ?? state}
                      </span>
                    )}
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
  | { kind: "add" }
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

  if (!state) return <div className="text-muted flex h-full items-center justify-center">加载中…</div>;

  const { config, skills, home } = state;
  const targets = config.targets;
  const current = targets.find((t) => t.id === view);
  const groupNames = [...new Set(skills.map((s) => s.group))];
  /** A path of this machine, with the home directory as ~. */
  const short = (path: string) => (path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path);
  const pathOf = (t: Target) => (t.global ? GLOBAL_PATH : t.host ? t.path : short(t.path));

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
    <div className="flex h-full">
      {/* Sidebar: the skills page and the list of targets */}
      <nav aria-label="导航" className="border-line bg-side flex w-[232px] shrink-0 flex-col gap-[18px] border-r px-2.5 pt-4 pb-3">
        <div className="flex items-center gap-2.5 px-1.5">
          <img src="/icon.png" alt="" className="-m-[3px] size-[34px]" />
          <div className="min-w-0">
            <div className="text-[14px] font-[650] tracking-[-0.01em]">Skills Hub</div>
            <div className="text-muted truncate text-[11px]" title={config.storePath}>
              仓库 {short(config.storePath)}
            </div>
          </div>
        </div>

        <SideItem active={view === "skills"} onClick={() => setView("skills")} icon="grid" label="全部技能" count={skills.length} />

        <div className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-2.5">
          {byHost(targets).map(([host, list]) => {
            const failed = list.some((t) => statuses[t.id]?.error);
            const pending = list.every((t) => !statuses[t.id]);
            return (
              <div key={host} className="flex flex-col gap-0.5">
                <div className="text-muted flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold">
                  <span className="min-w-0 flex-1 truncate">{host ? `远程 · ${host}` : "本机"}</span>
                  {host && !pending && (
                    <span className="flex items-center gap-1 font-medium">
                      <span className={`size-1.5 rounded-full ${failed ? "bg-danger" : "bg-ok"}`} />
                      {failed ? "连接失败" : "已连接"}
                    </span>
                  )}
                </div>
                {list.map((t) => {
                  const st = statuses[t.id];
                  return (
                    <SideItem
                      key={t.id}
                      active={view === t.id}
                      onClick={() => setView(t.id)}
                      icon={t.global ? "globe" : "folder"}
                      label={t.global ? "全局" : t.name}
                      count={st && !st.error ? st.items.length : undefined}
                      dot={!st?.error && st?.items.some((i) => i.state === "outdated")}
                      loading={scanning.has(t.id)}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="flex gap-1.5">
          <button
            className="border-line-strong text-ink-2 hover:bg-fill flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-dashed"
            onClick={() => setModal({ kind: "add" })}
          >
            <Icon name="plus" size={14} />
            添加项目或主机
          </button>
          <button aria-label="设置" title="设置" className="icon-btn size-8" onClick={() => setModal({ kind: "settings" })}>
            <Icon name="sliders" />
          </button>
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <TargetView
            key={current.id}
            target={current}
            path={pathOf(current)}
            status={statuses[current.id]}
            scanning={scanning.has(current.id)}
            onRescan={() => scan([current.id])}
            onInstall={(names) => installTo([current.id], names)}
            onUninstall={(names) =>
              confirm(`从「${targetLabel(current)}」删除 ${names.length} 个技能？`, names.join("、"), "删除", () => void uninstall(current.id, names))
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
            onOpen={() => void Hub.openPath(current.global ? home : current.path).catch(fail)}
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
            onGroup={(names) => setModal({ kind: "group", names, current: names.length === 1 ? (config.groups[names[0]!] ?? "") : "" })}
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
          <div className="border-line bg-card text-muted flex items-center gap-2 border-t px-6 py-2">
            <span className="border-fill border-t-accent size-3 animate-spin rounded-full border-2" />
            {busy}
          </div>
        )}
      </main>

      {modal?.kind === "installTo" && (
        <InstallToDialog
          names={modal.names}
          targets={targets}
          statuses={statuses}
          pathOf={pathOf}
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
          storePath={short(config.storePath)}
          onClose={() => setModal(null)}
          onInstall={(spec, group) => {
            setModal(null);
            void runTask("安装技能到仓库", (log) => Hub.storeInstall(spec, group, log));
          }}
        />
      )}
      {modal?.kind === "add" && (
        <AddDialog
          hosts={[...new Set(targets.map((t) => t.host).filter(Boolean))]}
          onClose={() => setModal(null)}
          onError={fail}
          onAddProject={async (host, path, name) => {
            const t = await Hub.addProject(host, path, name);
            // A new host also gets its global skills listed.
            if (host && !targets.some((o) => o.host === host && o.global)) await Hub.addHost(host).catch(() => {});
            setModal(null);
            setView(t.id);
            await reload();
          }}
          onAddHost={async (host) => {
            const t = await Hub.addHost(host);
            setModal(null);
            setView(t.id);
            await reload();
          }}
        />
      )}
      {modal?.kind === "settings" && (
        <SettingsDialog state={state} onClose={() => setModal(null)} onError={fail} onChanged={() => reload().catch(fail)} />
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
          title="SKILL.md"
          header={<span className="font-mono text-[12px] font-semibold">{modal.name}</span>}
          width="w-[720px]"
          onClose={() => setModal(null)}
          footer={
            <button className="btn" onClick={() => setModal(null)}>
              关闭
            </button>
          }
        >
          <pre className="selectable m-0 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">{modal.text}</pre>
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
                className="btn btn-primary px-4"
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
          <div className="selectable text-ink-2 max-h-60 overflow-auto whitespace-pre-wrap">{modal.message}</div>
        </Dialog>
      )}

      {task && (
        <Dialog
          title={task.title}
          width="w-[720px]"
          footer={
            <>
              {!task.done && <span className="text-muted mr-auto">正在运行…</span>}
              {task.done && <span className={`mr-auto font-medium ${task.error ? "text-danger" : "text-ok"}`}>{task.error || "完成"}</span>}
              <button className="btn btn-primary px-4" disabled={!task.done} onClick={() => setTask(null)}>
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
          className="selectable fixed right-4 bottom-4 z-50 max-w-md rounded-[10px] bg-[#b42318] px-3.5 py-2.5 whitespace-pre-wrap text-white shadow-xl"
          onClick={() => setToast("")}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function SideItem(props: { active: boolean; onClick: () => void; icon: IconName; label: string; count?: number; dot?: boolean; loading?: boolean }) {
  return (
    <button
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
      className={`flex h-[30px] w-full shrink-0 items-center gap-[9px] rounded-lg px-2 text-left ${
        props.active ? "bg-card font-semibold shadow-[0_1px_2px_rgb(28_28_40/0.08),0_0_0_1px_rgb(28_28_40/0.05)]" : "hover:bg-fill"
      }`}
    >
      <Icon name={props.icon} className={props.active ? "text-accent" : "text-muted"} />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.dot && <span title="有可更新的技能" className="bg-warn-dot size-[7px] rounded-full" />}
      {props.loading ? (
        <span className="border-line-strong border-t-muted size-2.5 animate-spin rounded-full border-[1.5px]" />
      ) : (
        props.count !== undefined && <span className="text-muted text-[12px] font-normal">{props.count}</span>
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
      className="selectable m-0 h-[380px] overflow-auto rounded-[10px] bg-[#14141a] p-3.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#d8d8e2]"
    >
      {lines.join("\n")}
    </pre>
  );
}

function PageHeader(props: { eyebrow?: string; title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end gap-2.5 px-6 pt-5 pb-3.5">
      <div className="min-w-0 flex-[1_1_240px]">
        {props.eyebrow && <div className="text-muted text-[12px]">{props.eyebrow}</div>}
        <h1 className="m-0 truncate text-[21px] font-[650] tracking-[-0.015em]">{props.title}</h1>
        <div className="text-muted mt-0.5 truncate">{props.sub}</div>
      </div>
      {props.children}
    </header>
  );
}

// ---- Skills page ----

function inFilter(s: Skill, filter: string): boolean {
  if (filter === "pinned") return s.override !== "";
  if (filter === "manual") return s.trigger !== "auto";
  if (filter === "auto") return s.trigger === "auto";
  return true;
}

const FILTERS: [string, string][] = [
  ["", "全部"],
  ["auto", "自动"],
  ["manual", "手动"],
  ["pinned", "我固定的"],
];

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
  const [filter, setFilter] = useState(""); // one of FILTERS

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
  const groups = groupSkills(skills.filter((s) => matches(s, query) && inFilter(s, filter)));
  const allGroups = [...new Set(skills.map((s) => s.group))];
  const anyOpen = allGroups.some((g) => !collapsed.has(g));

  return (
    <>
      <PageHeader
        title="全部技能"
        sub={`${skills.length} 个技能 · ${allGroups.length} 个分组 · ${skills.filter((s) => s.trigger !== "auto").length} 个手动触发`}
      >
        {props.outdatedCount > 0 && (
          <button className="btn btn-warn" onClick={props.onSyncAll} title="把所有项目里落后的副本更新到仓库的版本">
            <Icon name="up" size={14} />
            同步 {props.outdatedCount} 个项目
          </button>
        )}
        <button aria-label="刷新" title="刷新" className="btn w-8 px-0" onClick={props.onReload}>
          <Icon name="refresh" size={14} />
        </button>
        <button className="btn" onClick={() => props.onStoreUpdate([])} title="npx skills update">
          更新全部
        </button>
        <button className="btn btn-primary px-3.5" onClick={props.onStoreInstall}>
          <Icon name="plus" size={14} width={1.8} />
          安装技能
        </button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2.5 px-6 pb-3.5">
        <label className="input text-muted focus-within:border-accent focus-within:ring-accent/20 flex w-[260px] items-center gap-2 focus-within:ring-2">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="搜索技能"
            placeholder="搜索技能、描述或分组"
            className="text-ink min-w-0 flex-1 border-0 bg-transparent outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div role="group" aria-label="按触发方式筛选" className="seg">
          {FILTERS.map(([value, label]) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
              <span className="text-muted font-normal">{skills.filter((s) => inFilter(s, value)).length}</span>
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button className="btn btn-ghost" onClick={() => setCollapsed(anyOpen ? new Set(allGroups) : new Set())}>
          <Icon name="fold" size={14} />
          {anyOpen ? "全部收起" : "全部展开"}
        </button>
        <button className="btn btn-ghost" onClick={props.onAddSource} title="关联一个放着你自己写的技能的文件夹">
          <Icon name="folder" size={14} />
          关联本地文件夹
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-6 pb-6">
        {skills.length === 0 && (
          <div className="text-muted flex flex-1 flex-col items-center justify-center gap-3">
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
        {skills.length > 0 && groups.length === 0 && <div className="text-muted p-10 text-center">没有符合条件的技能</div>}
        {groups.map(([group, list]) => {
          const names = list.filter((s) => !s.conflict).map((s) => s.name);
          const count = names.filter((n) => selected.has(n)).length;
          const storeNames = list.filter((s) => !s.conflict && s.origin === "store").map((s) => s.name);
          const installed = names.filter((n) => installedIn.has(n)).length;
          const local = list.every((s) => s.origin === "local");
          const open = !collapsed.has(group) || query.trim() !== "";
          return (
            <section key={group} className="card shrink-0">
              <div className="flex h-[46px] items-center gap-2.5 pr-3 pl-3.5" onClick={() => setCollapsed(toggled(collapsed, [group], open))}>
                <Check
                  label="选择整组"
                  checked={names.length > 0 && count === names.length}
                  partial={count > 0}
                  onChange={(on) => setSelected(toggled(selected, names, on))}
                />
                <Icon name={open ? "down" : "right"} size={14} className="text-muted" width={1.7} />
                <GroupTile name={group} />
                <h2 className="m-0 truncate font-mono text-[13px] font-semibold">{group}</h2>
                <span className="bg-fill text-ink-2 rounded-full px-[7px] py-px text-[12px]">{list.length}</span>
                {local && <span className="chip bg-local-bg text-local">本地</span>}
                <div className="flex-1" />
                {installed > 0 && <span className="text-muted whitespace-nowrap">{installed} 个已安装</span>}
                <button
                  className="btn btn-sm"
                  disabled={names.length === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onInstallTo(names);
                  }}
                >
                  安装整组
                </button>
                <Menu
                  label="分组操作"
                  items={[
                    { label: "重命名分组", onClick: () => props.onGroup(names) },
                    ...(storeNames.length > 0
                      ? [
                          { label: "更新整组", onClick: () => props.onStoreUpdate(storeNames) },
                          { label: "删除整组", danger: true, onClick: () => props.onStoreRemove(storeNames) },
                        ]
                      : []),
                  ]}
                />
              </div>
              {open &&
                list.map((s) => (
                  <div
                    key={s.path}
                    className="group border-line-soft hover:bg-hover flex min-h-[54px] items-center gap-3 border-t py-1.5 pr-3 pl-3.5 last:rounded-b-xl"
                  >
                    <Check
                      label="选择技能"
                      checked={selected.has(s.name) && !s.conflict}
                      disabled={s.conflict}
                      onChange={(on) => setSelected(toggled(selected, [s.name], on))}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-[30px]">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="selectable truncate font-mono text-[13px] font-semibold">{s.name}</span>
                        {s.conflict ? (
                          <span className="chip bg-danger-bg text-danger" title="已有同名技能，这个无法安装">
                            重名
                          </span>
                        ) : (
                          <TriggerSelect skill={s} onChange={(mode) => props.onTrigger([s.name], mode)} />
                        )}
                        {s.origin === "local" && !local && (
                          <span className="chip bg-local-bg text-local" title={s.path}>
                            本地
                          </span>
                        )}
                      </div>
                      <div className="text-muted truncate text-[12px]" title={s.description}>
                        {s.description || "—"}
                      </div>
                    </div>
                    <div className="flex max-w-[45%] shrink-0 flex-wrap items-center justify-end gap-[5px] group-hover:hidden">
                      {(installedIn.get(s.name) ?? []).map(({ target, item }) => (
                        <span key={target.id} className="pill" title={`${targetLabel(target)} · ${STATE_LABEL[item.state] ?? item.state}`}>
                          <StateIcon state={item.state} size={12} />
                          {targetLabel(target)}
                        </span>
                      ))}
                    </div>
                    <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                      <button aria-label="查看 SKILL.md" title="查看 SKILL.md" className="icon-btn" onClick={() => props.onPreview(s.name)}>
                        <Icon name="eye" size={15} />
                      </button>
                      <button aria-label="打开文件夹" title="打开文件夹" className="icon-btn" onClick={() => props.onOpen(s.path)}>
                        <Icon name="folder" size={15} />
                      </button>
                      {!s.conflict && (
                        <button aria-label="设置分组" title="设置分组" className="icon-btn" onClick={() => props.onGroup([s.name])}>
                          <Icon name="tag" size={15} />
                        </button>
                      )}
                      {s.origin === "store" && (
                        <>
                          <button aria-label="从源头更新" title="从源头更新" className="icon-btn" onClick={() => props.onStoreUpdate([s.name])}>
                            <Icon name="refresh" size={15} />
                          </button>
                          <button aria-label="从仓库删除" title="从仓库删除" className="icon-btn text-danger" onClick={() => props.onStoreRemove([s.name])}>
                            <Icon name="trash" size={15} />
                          </button>
                        </>
                      )}
                    </div>
                    <button className="btn btn-sm" disabled={s.conflict} onClick={() => props.onInstallTo([s.name])}>
                      安装到…
                    </button>
                  </div>
                ))}
            </section>
          );
        })}
      </div>

      {picked.length > 0 && (
        <footer className="border-line bg-card flex items-center gap-2 border-t px-6 py-2.5">
          <span className="bg-accent flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[12px] font-semibold text-white">
            {picked.length}
          </span>
          <span className="font-semibold">个技能已选</span>
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
          <div className="flex-1" />
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
          <button className="btn btn-primary px-4" onClick={() => props.onInstallTo(picked)}>
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

const TABLE_COLS = "grid grid-cols-[15px_minmax(0,2.2fr)_104px_104px_minmax(0,2fr)_112px] items-center gap-3 px-3.5";

function TargetView(props: {
  target: Target;
  path: string;
  status: TargetStatus | undefined;
  scanning: boolean;
  onRescan: () => void;
  onInstall: (names: string[]) => void;
  onUninstall: (names: string[]) => void;
  onAdd: () => void;
  onChange: (t: Target) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const { target: t, status } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const items = status?.items ?? [];
  const names = items.map((i) => i.name);
  const picked = names.filter((n) => selected.has(n));
  const outdated = items.filter((i) => i.state === "outdated").map((i) => i.name);
  const managed = items.filter((i) => i.state !== "foreign" && i.state !== "conflict").map((i) => i.name);
  const count = (...states: string[]) => items.filter((i) => states.includes(i.state)).length;
  const link = t.mode === "link" && !t.host;
  const stats: [number, string, string][] = [
    [count("linked", "synced"), "已是最新", ""],
    [count("outdated"), "可更新", "text-warn"],
    [count("foreign", "conflict"), "外部", ""],
  ];

  return (
    <>
      <PageHeader
        eyebrow={`${t.host ? `远程 · ${t.host}` : "本机"} · ${t.global ? "全局" : "项目"}`}
        title={t.global ? "全局" : t.name}
        sub={<span className="selectable font-mono text-[12px]">{props.path}</span>}
      >
        {!t.host && (
          <button className="btn" onClick={props.onOpen}>
            打开目录
          </button>
        )}
        <button aria-label="重新扫描" title="重新扫描" className="btn w-8 px-0" onClick={props.onRescan} disabled={props.scanning}>
          <Icon name="refresh" size={14} className={props.scanning ? "animate-spin" : ""} />
        </button>
        <Menu
          bordered
          label="更多操作"
          items={[
            ...(managed.length > 0 ? [{ label: "全部重装", onClick: () => props.onInstall(managed) }] : []),
            ...(t.id !== "local-global" ? [{ label: "从列表移除", danger: true, onClick: props.onRemove }] : []),
          ]}
        />
        <button className="btn btn-primary px-3.5" onClick={props.onAdd}>
          <Icon name="plus" size={14} width={1.8} />
          添加技能
        </button>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-6 pb-6">
        <section aria-label="安装设置" className="card flex shrink-0 flex-wrap items-center gap-x-7 gap-y-3.5 px-4 py-3.5">
          <div className="flex flex-col gap-1.5">
            <div className="label">安装方式</div>
            <div role="group" aria-label="安装方式" className="seg" title={t.host ? "远程主机只能复制" : ""}>
              <button aria-pressed={link} disabled={!!t.host} onClick={() => props.onChange({ ...t, mode: "link" })}>
                <Icon name="link" size={13} />
                软链接
              </button>
              <button aria-pressed={!link} onClick={() => props.onChange({ ...t, mode: "copy" })}>
                <Icon name="copy" size={13} />
                复制
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="label">安装到</div>
            <div className="flex flex-wrap gap-2">
              <label className="border-line-strong flex h-8 items-center gap-[7px] rounded-lg border px-2.5 font-mono text-[12px]">
                <Check checked={t.agents} onChange={(on) => props.onChange({ ...t, agents: on })} />
                .agents/skills
              </label>
              <label className="border-line-strong flex h-8 items-center gap-[7px] rounded-lg border px-2.5 font-mono text-[12px]">
                <Check checked={t.claude} onChange={(on) => props.onChange({ ...t, claude: on })} />
                .claude/skills
              </label>
            </div>
          </div>
          <div className="flex-[1_1_40px]" />
          <dl className="m-0 flex gap-[22px]">
            {stats.map(([n, label, color]) => (
              <div key={label}>
                <dd className={`m-0 text-[20px] leading-tight font-[650] ${n > 0 ? color : ""}`}>{status && !status.error ? n : "–"}</dd>
                <dt className="label">{label}</dt>
              </div>
            ))}
          </dl>
          {outdated.length > 0 && (
            <button className="btn btn-warn" onClick={() => props.onInstall(outdated)}>
              <Icon name="up" size={14} />
              同步 {outdated.length} 个更新
            </button>
          )}
        </section>

        {status?.error && <div className="selectable bg-danger-bg text-danger shrink-0 rounded-xl p-3.5 whitespace-pre-wrap">{status.error}</div>}
        {!status && <div className="text-muted p-10 text-center">扫描中…</div>}
        {status && !status.error && items.length === 0 && (
          <div className="text-muted flex flex-1 flex-col items-center justify-center gap-3">
            <div>这里还没有安装技能</div>
            <button className="btn btn-primary" onClick={props.onAdd}>
              添加技能
            </button>
          </div>
        )}
        {items.length > 0 && (
          <section aria-label="已安装的技能" className="card shrink-0 overflow-x-auto">
            <div className="min-w-[680px]">
              <div className={`${TABLE_COLS} text-muted h-[38px] text-[12px] font-semibold`}>
                <Check
                  label="全选"
                  checked={picked.length === names.length}
                  partial={picked.length > 0}
                  onChange={(on) => setSelected(on ? new Set(names) : new Set())}
                />
                <div>{picked.length > 0 ? `已选 ${picked.length} 个` : "技能"}</div>
                <div>触发</div>
                <div>状态</div>
                <div>位置</div>
                <div className="flex justify-end">
                  {picked.length > 0 && (
                    <button className="btn btn-sm btn-danger font-normal" onClick={() => props.onUninstall(picked)}>
                      删除所选
                    </button>
                  )}
                </div>
              </div>
              {items.map((it) => (
                <div key={it.name} className={`${TABLE_COLS} border-line-soft hover:bg-hover min-h-12 border-t`}>
                  <Check label="选择技能" checked={selected.has(it.name)} onChange={(on) => setSelected(toggled(selected, [it.name], on))} />
                  <div className="selectable truncate font-mono font-semibold">{it.name}</div>
                  <div className="flex">
                    <TriggerBadge trigger={it.trigger} title="这份已安装的技能在 Claude Code 和 Codex 里的触发方式" />
                  </div>
                  <div className={`flex items-center gap-1.5 whitespace-nowrap ${it.state === "outdated" ? "text-warn font-semibold" : ""}`}>
                    <StateIcon state={it.state} />
                    {STATE_LABEL[it.state] ?? it.state}
                  </div>
                  <div className="text-muted truncate font-mono text-[12px]" title={it.linkTo || placement(it)}>
                    {placement(it)}
                    {(it.state === "foreign" || it.state === "conflict") && it.linkTo ? ` · ${it.linkTo}` : ""}
                  </div>
                  <div className="flex items-center justify-end gap-1">
                    {it.state === "outdated" && (
                      <button className="btn btn-sm font-medium" onClick={() => props.onInstall([it.name])}>
                        同步
                      </button>
                    )}
                    {it.state === "conflict" && (
                      <button className="btn btn-sm" onClick={() => props.onInstall([it.name])} title="用仓库里的同名技能替换它">
                        替换
                      </button>
                    )}
                    <button aria-label="从这里删除" title="从这里删除" className="icon-btn text-muted" onClick={() => props.onUninstall([it.name])}>
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

// ---- Dialogs ----

function InstallToDialog(props: {
  names: string[];
  targets: Target[];
  statuses: Statuses;
  pathOf: (t: Target) => string;
  onClose: () => void;
  onInstall: (targetIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Dialog
      title={`安装 ${props.names.length} 个技能到…`}
      header={
        <div className="flex max-h-[76px] flex-wrap gap-1.5 overflow-auto">
          {props.names.map((n) => (
            <span key={n} className="bg-fill h-[22px] rounded-md px-2 font-mono text-[12px] leading-[22px]">
              {n}
            </span>
          ))}
        </div>
      }
      onClose={props.onClose}
      footer={
        <>
          <span className="text-muted mr-auto">
            {picked.size > 0 ? `已选 ${picked.size} 个位置 · ` : ""}同名技能会被整体替换
          </span>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary px-4" disabled={picked.size === 0} onClick={() => props.onInstall([...picked])}>
            安装
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {byHost(props.targets).map(([host, list]) => (
          <div key={host} className="flex flex-col gap-1.5">
            <div className="text-muted text-[11px] font-semibold">{host ? `远程 · ${host}` : "本机"}</div>
            <div className="border-line overflow-hidden rounded-[10px] border">
              {list.map((t) => {
                const st = props.statuses[t.id];
                const have = new Map((st?.items ?? []).map((i) => [i.name, i.state]));
                const current = props.names.filter((n) => ["linked", "synced"].includes(have.get(n) ?? "")).length;
                return (
                  <label
                    key={t.id}
                    className={`border-line-soft flex min-h-12 items-center gap-2.5 border-t px-3 py-1.5 first:border-0 ${picked.has(t.id) ? "bg-accent-soft" : "hover:bg-hover"}`}
                  >
                    <Check checked={picked.has(t.id)} onChange={(on) => setPicked(toggled(picked, [t.id], on))} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-semibold">{t.global ? "全局" : t.name}</span>
                      <span className="text-muted truncate font-mono text-[11px]">{props.pathOf(t)}</span>
                    </span>
                    {st?.error ? (
                      <span className="chip bg-danger-bg text-danger">连接失败</span>
                    ) : (
                      current > 0 && (
                        <span className="text-muted text-[12px] whitespace-nowrap">
                          已装 {current}/{props.names.length}
                        </span>
                      )
                    )}
                    <ModeTag target={t} />
                  </label>
                );
              })}
            </div>
          </div>
        ))}
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
      width="w-[680px]"
      onClose={props.onClose}
      footer={
        <>
          <span className="mr-auto">
            <ModeTag target={props.target} />
          </span>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary px-4" disabled={picked.size === 0} onClick={() => props.onInstall([...picked])}>
            安装 {picked.size || ""}
          </button>
        </>
      }
    >
      <SkillPicker skills={props.skills} selected={picked} onChange={setPicked} installed={installed} />
    </Dialog>
  );
}

function StoreInstallDialog(props: { groups: string[]; storePath: string; onClose: () => void; onInstall: (spec: string, group: string) => void }) {
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
          <button className="btn btn-primary px-4" disabled={!spec.trim()} onClick={() => props.onInstall(spec, group)}>
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

function HostInput(props: { value: string; onChange: (v: string) => void }) {
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    Hub.sshHosts().then(setKnown, () => {});
  }, []);
  return (
    <>
      <input
        className="input font-mono"
        list="ssh-hosts"
        placeholder="home 或 user@host"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
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

type AddKind = "local" | "remote" | "host";

const ADD_KINDS: [AddKind, string][] = [
  ["local", "本机项目"],
  ["remote", "远程项目"],
  ["host", "远程主机"],
];

/** Adds a project of this machine or of a host, or a host's global skills. */
function AddDialog(props: {
  hosts: string[];
  onClose: () => void;
  onError: (err: unknown) => void;
  onAddProject: (host: string, path: string, name: string) => Promise<void>;
  onAddHost: (host: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<AddKind>("local");
  const [host, setHost] = useState(props.hosts[0] ?? "");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const ready = kind === "host" ? !!host.trim() : !!path.trim() && (kind === "local" || !!host.trim());
  const submit = async () => {
    setWorking(true);
    try {
      if (kind === "host") await props.onAddHost(host);
      else await props.onAddProject(kind === "remote" ? host : "", path, name);
    } catch (err) {
      props.onError(err);
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      title="添加项目或主机"
      header={
        <div role="group" aria-label="类型" className="seg self-start">
          {ADD_KINDS.map(([value, label]) => (
            <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>
              {label}
            </button>
          ))}
        </div>
      }
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button className="btn btn-primary px-4" disabled={working || !ready} onClick={submit}>
            {working ? "检查中…" : "添加"}
          </button>
        </>
      }
    >
      {kind !== "local" && (
        <Field
          label="SSH 主机"
          hint={
            kind === "host"
              ? "会添加这台主机的全局技能目录（~/.agents/skills 和 ~/.claude/skills）。需要能用 ssh 免密直连。"
              : "用 ssh 命令能直接连上的名字，需要免密登录。"
          }
        >
          <HostInput value={host} onChange={setHost} />
        </Field>
      )}
      {kind !== "host" && (
        <>
          <Field label="项目路径">
            <div className="flex gap-1.5">
              <input
                className="input font-mono"
                placeholder={kind === "remote" ? "~/projects/my-app" : "/Users/me/projects/my-app"}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                spellCheck={false}
              />
              {kind === "local" && (
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
        </>
      )}
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
          <button className="btn btn-primary px-4" onClick={() => props.onSave(group)}>
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
      width="w-[620px]"
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
      <div className="label mb-1.5">本地文件夹</div>
      <div className="border-line overflow-hidden rounded-[10px] border">
        {config.sources.length === 0 && <div className="text-muted p-3.5 text-center">还没有关联本地文件夹</div>}
        {config.sources.map((s) => (
          <div key={s.id} className="border-line-soft flex h-10 items-center gap-2 border-t pr-1.5 pl-3 first:border-0">
            <Icon name="folder" className="text-muted" />
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]">{s.path}</span>
            <span className="text-muted text-[12px]">{props.state.skills.filter((k) => k.origin === "local" && k.source === s.path).length} 个技能</span>
            <button className="btn btn-sm btn-ghost" onClick={() => void Hub.openPath(s.path).catch(props.onError)}>
              打开
            </button>
            <button className="btn btn-sm btn-ghost btn-danger" onClick={() => void act(Hub.removeSource(s.id))}>
              取消关联
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2.5">
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
          <Icon name="plus" size={14} />
          关联文件夹
        </button>
        <span className="text-muted text-[12px]">可以是单个技能的文件夹，也可以是放着多个技能的文件夹。技能直接从原位置读取，改了立即生效。</span>
      </div>
    </Dialog>
  );
}

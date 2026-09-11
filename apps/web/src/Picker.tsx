import { useEffect, useMemo, useState } from "react";
import type { Attachment } from "@aicommander/protocol";
import { Pick, type PickItem } from "./Pick.js";

/**
 * §10 the `+` picker — four tabs over the same Pick component.
 *
 * The tabs are `@ files`, `/ skills`, `# tools`, `! images`, matching the sigils that
 * type the same thing into the prompt. Each row says where the thing will land in
 * context, because §0 principle 2 is that the harness decides that — and the user
 * should be able to see the decision rather than guess at it.
 */

export type PickerTab = "files" | "skills" | "tools" | "images";

const TABS: { id: PickerTab; sigil: string; label: string }[] = [
  { id: "files", sigil: "@", label: "files" },
  { id: "skills", sigil: "/", label: "skills" },
  { id: "tools", sigil: "#", label: "tools" },
  { id: "images", sigil: "!", label: "images" },
];

export interface PickerProps {
  tab: PickerTab;
  onTab: (tab: PickerTab) => void;
  files: readonly string[];
  skills: readonly { name: string; description: string }[];
  tools: readonly { name: string; description: string; enabled: boolean }[];
  images: readonly { file: string; name: string }[];
  /** Attach it, and optionally open it in the other panel (⌘⏎). */
  onAttach: (attachment: Attachment, alsoOpen: boolean) => void;
  onClose: () => void;
  /** ! tab: pick an image from disk. */
  onUpload: () => void;
}

/** What the harness will do with this attachment, shown on the row (§7). */
function placement(tab: PickerTab): string {
  switch (tab) {
    case "files": return "content above your message";
    case "skills": return "full text, once per session";
    case "tools": return "enabled for this session";
    case "images": return "vision content, or a note if the model can't see";
  }
}

export function Picker({
  tab, onTab, files, skills, tools, images, onAttach, onClose, onUpload,
}: PickerProps): JSX.Element {
  const items = useMemo((): PickItem[] => {
    switch (tab) {
      case "files":
        return files.map((path) => ({ id: path, label: path, detail: placement("files") }));
      case "skills":
        return skills.map((s) => ({
          id: s.name, label: s.name, detail: s.description, keywords: s.description,
        }));
      case "tools":
        return tools.map((t) => ({
          id: t.name,
          label: t.name,
          detail: t.enabled ? "on" : t.description,
          keywords: t.description,
        }));
      case "images":
        return [
          { id: "__upload", label: "choose a file…", detail: "png, jpg, gif, webp" },
          ...images.map((i) => ({ id: i.file, label: i.name, detail: "already in this session" })),
        ];
    }
  }, [tab, files, skills, tools, images]);

  const choose = (item: PickItem, alt: boolean): void => {
    switch (tab) {
      case "files": onAttach({ kind: "file", path: item.id, hash: "" }, alt); return;
      case "skills": onAttach({ kind: "skill", name: item.id }, alt); return;
      case "tools": onAttach({ kind: "tool", name: item.id }, alt); return;
      case "images":
        if (item.id === "__upload") onUpload();
        else onAttach({ kind: "image", file: item.id }, alt);
    }
  };

  // ⇥ moves between tabs, the way the mockup's four-tab strip implies.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab);
      onTab(TABS[(i + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length]!.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tab, onTab]);

  return (
    <Pick
      title="attach"
      placeholder={`filter ${tab}`}
      hint="⏎ attach · ⌘⏎ attach and open · ⇥ tab · Esc close"
      items={items}
      onChoose={choose}
      onClose={onClose}
      header={
        <div className="picker-tabs">
          {TABS.map((t) => (
            <span
              key={t.id}
              className={t.id === tab ? "picker-tab on" : "picker-tab"}
              onMouseDown={(e) => { e.preventDefault(); onTab(t.id); }}
            >
              <b>{t.sigil}</b> {t.label}
            </span>
          ))}
        </div>
      }
    />
  );
}

export { TABS };

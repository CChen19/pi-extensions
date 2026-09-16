import type { MarkdownTransformer, Theme } from "@earendil-works/pi-coding-agent";
import type { SideThreadTurn } from "./side-thread.js";

export type BtwMarkdownTransformers = (theme: Theme) => readonly MarkdownTransformer[];

type MermaidMarkdownModule = typeof import("@narumitw/pi-tui-kit/markdown");

const MERMAID_MARKDOWN_MODULE = "@narumitw/pi-tui-kit/markdown";
const noMarkdownTransformers: BtwMarkdownTransformers = () => [];

export async function prepareBtwTranscriptMarkdown(
  turns: readonly SideThreadTurn[],
  pendingQuestion?: string,
): Promise<BtwMarkdownTransformers> {
  const documents = turns.flatMap((turn) =>
    turn.kind === "answered" ? [turn.question, turn.answer] : [turn.question],
  );
  if (pendingQuestion) documents.push(pendingQuestion);
  if (!documents.some((document) => /mermaid/iu.test(document))) return noMarkdownTransformers;

  const { createMermaidMarkdownTransformer, prepareMermaidMarkdownRenderer } = (await import(
    MERMAID_MARKDOWN_MODULE
  )) as MermaidMarkdownModule;
  const preparations = new Set<Promise<void>>();
  for (const document of documents) {
    const preparation = prepareMermaidMarkdownRenderer(document);
    if (preparation) preparations.add(preparation);
  }
  if (preparations.size > 0) await Promise.all(preparations);

  return (theme) => {
    const transformer = createMermaidMarkdownTransformer(theme);
    return transformer ? [transformer] : [];
  };
}

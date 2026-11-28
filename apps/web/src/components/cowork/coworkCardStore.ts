import { create } from "zustand";

interface CoworkCardState {
  /** Prefill from `/cowork <topic>`. */
  readonly topic: string;
  readonly collapsed: boolean;
}

interface CoworkCardStore {
  readonly cards: Readonly<Record<string, CoworkCardState>>;
  readonly open: (threadKey: string, topic?: string) => void;
  readonly setCollapsed: (threadKey: string, collapsed: boolean) => void;
  readonly close: (threadKey: string) => void;
}

/** Which threads show the Cowork card above the composer, keyed by scoped thread key. */
export const useCoworkCardStore = create<CoworkCardStore>()((set) => ({
  cards: {},
  open: (threadKey, topic) =>
    set(({ cards }) => ({
      cards: {
        ...cards,
        [threadKey]: {
          topic: topic?.trim() || (cards[threadKey]?.topic ?? ""),
          collapsed: false,
        },
      },
    })),
  setCollapsed: (threadKey, collapsed) =>
    set(({ cards }) => ({
      cards: { ...cards, [threadKey]: { topic: cards[threadKey]?.topic ?? "", collapsed } },
    })),
  close: (threadKey) =>
    set(({ cards }) => {
      const { [threadKey]: _closed, ...rest } = cards;
      return { cards: rest };
    }),
}));

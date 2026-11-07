import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getMotionEnabled, subscribeMotion } from "../store/motion";

type Snapshot = { rect: DOMRect; node: HTMLElement; area: string };
const reducedQuery = "(prefers-reduced-motion: reduce)";
// One shared MediaQueryList instead of a new matchMedia() call on every render.
let reducedMedia: MediaQueryList | null = null;
const reducedList = () => (reducedMedia ??= window.matchMedia(reducedQuery));
const subscribeReduced = (listener: () => void) => {
  const media = reducedList();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};

/** Visual-only FLIP transitions. Server state commits immediately; no animation
 * completion callback advances a turn or releases an input lock. */
export function useCardMotion(roundKey: string, layoutKey: string) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, Snapshot>());
  const previousRound = useRef(roundKey);
  const active = useRef(new Set<Animation>());
  const ghosts = useRef(new Set<HTMLElement>());
  const enabled = useSyncExternalStore(
    subscribeMotion,
    getMotionEnabled,
    () => false,
  );
  const reduced = useSyncExternalStore(
    subscribeReduced,
    () => reducedList().matches,
    () => true,
  );

  const cancel = () => {
    for (const animation of active.current) animation.cancel();
    active.current.clear();
    for (const ghost of ghosts.current) ghost.remove();
    ghosts.current.clear();
  };

  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    cancel();
    // Animations off: skip measuring every card (forced layout) on each render.
    if (!enabled || reduced) {
      previous.current = new Map();
      previousRound.current = roundKey;
      return;
    }
    const fresh = new Map<string, Snapshot>();
    for (const node of container.querySelectorAll<HTMLElement>(
      "[data-cl-card]",
    )) {
      fresh.set(node.dataset.clCard!, {
        node,
        rect: node.getBoundingClientRect(),
        area: node.dataset.clArea!,
      });
    }
    const sameRound = previousRound.current === roundKey;
    const before = sameRound ? previous.current : new Map<string, Snapshot>();
    const play = (
      node: HTMLElement,
      frames: Keyframe[],
      duration: number,
      delay = 0,
      done?: () => void,
    ) => {
      if (typeof node.animate !== "function") {
        done?.();
        return;
      }
      const animation = node.animate(frames, {
        duration,
        delay,
        easing: "cubic-bezier(.2,.75,.25,1)",
        fill: "backwards",
      });
      active.current.add(animation);
      animation.onfinish = () => {
        active.current.delete(animation);
        done?.();
      };
    };
    if (enabled && !reduced) {
      const deck = container
        .querySelector("[data-cl-deck]")
        ?.getBoundingClientRect();
      const discard = container
        .querySelector("[data-cl-discard]")
        ?.getBoundingClientRect();
      let dealt = 0;
      for (const [id, card] of fresh) {
        const old = before.get(id);
        if (card.area === "fixed" || card.area === "search") continue;
        if (old) {
          const dx = old.rect.left - card.rect.left,
            dy = old.rect.top - card.rect.top;
          if (Math.abs(dx) + Math.abs(dy) > 1)
            play(
              card.node,
              [
                {
                  transform: `translate(${dx}px,${dy}px) scale(${old.rect.width / card.rect.width})`,
                },
                { transform: "translate(0,0) scale(1)" },
              ],
              200,
            );
        } else {
          const dx = deck
            ? Math.max(-180, Math.min(180, deck.left - card.rect.left))
            : 0;
          play(
            card.node,
            [
              {
                transform: `translate(${dx}px,24px) scale(.9) rotate(-3deg)`,
                opacity: 0,
              },
              { transform: "translate(0,0) scale(1) rotate(0)", opacity: 1 },
            ],
            180,
            Math.min(dealt++ * 12, 72),
          );
        }
      }
      for (const [id, card] of before) {
        if (fresh.has(id) || !["hand", "board"].includes(card.area)) continue;
        const ghost = card.node.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("data-cl-card");
        ghost.setAttribute("aria-hidden", "true");
        ghost.inert = true;
        ghost.classList.add("cl-card-ghost");
        Object.assign(ghost.style, {
          position: "fixed",
          left: `${card.rect.left}px`,
          top: `${card.rect.top}px`,
          width: `${card.rect.width}px`,
          height: `${card.rect.height}px`,
          margin: "0",
          zIndex: "80",
          pointerEvents: "none",
        });
        document.body.appendChild(ghost);
        ghosts.current.add(ghost);
        const dx = discard
          ? Math.max(-140, Math.min(140, discard.left - card.rect.left))
          : 0;
        play(
          ghost,
          [
            { transform: "translate(0,0) scale(1)", opacity: 1 },
            {
              transform: `translate(${dx}px,28px) scale(.75) rotate(4deg)`,
              opacity: 0,
            },
          ],
          150,
          0,
          () => {
            ghost.remove();
            ghosts.current.delete(ghost);
          },
        );
      }
    }
    previous.current = fresh;
    previousRound.current = roundKey;
  }, [roundKey, layoutKey, enabled, reduced]);

  useLayoutEffect(
    () => () => {
      cancel();
      previous.current.clear();
    },
    [],
  );
  return root;
}

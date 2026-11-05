import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCardMotion } from "../../src/card-link/useCardMotion";
import { setMotionEnabled } from "../../src/store/motion";

function Cards({ hand, board = [] }: { hand: number[]; board?: number[] }) {
  const ref = useCardMotion("round-1", `${hand}/${board}`);
  return (
    <div ref={ref}>
      <span data-cl-deck />
      <span data-cl-discard />
      {hand.map((id) => (
        <article key={`h${id}`} data-cl-card={id} data-cl-area="hand">
          ID {id}
        </article>
      ))}
      {board.map((id) => (
        <article key={`b${id}`} data-cl-card={id} data-cl-area="board">
          ID {id}
        </article>
      ))}
    </div>
  );
}
afterEach(() => {
  setMotionEnabled(true);
  vi.restoreAllMocks();
});
describe("card motion preference", () => {
  it("deals briefly and immediately cancels flying cards when the main setting is disabled", () => {
    const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
    const animate = vi.fn(() => {
      const animation = { cancel: vi.fn() };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    setMotionEnabled(true);
    const view = render(<Cards hand={[1, 2, 3, 4, 5, 6, 7]} />);
    expect(animate).toHaveBeenCalledTimes(7);
    for (const call of animate.mock.calls as unknown as [
      Keyframe[],
      KeyframeAnimationOptions,
    ][])
      expect(
        Number(call[1].duration) + Number(call[1].delay),
      ).toBeLessThanOrEqual(252);
    view.rerender(<Cards hand={[2, 3, 4, 5, 6, 7, 8]} />);
    expect(document.querySelectorAll(".cl-card-ghost")).toHaveLength(1);
    act(() => setMotionEnabled(false));
    expect(document.querySelectorAll(".cl-card-ghost")).toHaveLength(0);
    const count = animate.mock.calls.length;
    view.rerender(<Cards hand={[3, 4, 5, 6, 7, 8, 9]} />);
    expect(animate).toHaveBeenCalledTimes(count);
    expect(animations.some((a) => a.cancel.mock.calls.length)).toBe(true);
  });
  it("does not hold removed cards in the accessible game tree", () => {
    setMotionEnabled(false);
    const view = render(<Cards hand={[1, 2]} />);
    view.rerender(<Cards hand={[2]} />);
    expect(view.queryByText("ID 1")).toBeNull();
    expect(document.querySelector(".cl-card-ghost")).toBeNull();
  });
});

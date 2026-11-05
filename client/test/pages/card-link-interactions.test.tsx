import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../render";
import ConnectionSlot from "../../src/card-link/ConnectionSlot";
const periods=[{team:"Virtus.pro",start:"2020-01-01",end:"2022-05-01",sources:[]},{team:"AVANGAR",start:"2018-01-01",end:"2019-12-01",sources:[]}];
describe("card drag and connection details",()=>{
  it("shows all shared teams on hover, keyboard focus or tap, and dismisses stale details",()=>{
    const select=vi.fn();
    const view=renderWithProviders(<ConnectionSlot first="Qikert" second="Jame" evidence={[...periods,periods[0]]} onClick={select}>✓</ConnectionSlot>);
    const button=screen.getByRole("button");
    fireEvent.mouseEnter(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Qikert ↔ Jame");
    expect(screen.getAllByText("Virtus.pro")).toHaveLength(1);
    expect(screen.getByText("AVANGAR")).toBeInTheDocument();
    expect(screen.getByText("2020-01-01")).toBeInTheDocument();
    fireEvent.keyDown(button,{key:"Escape"});
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(button,{key:"Escape"});fireEvent.click(button);
    expect(select).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    view.rerender(<ConnectionSlot first="Other" second="Jame" evidence={[]}>＋</ConnectionSlot>);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

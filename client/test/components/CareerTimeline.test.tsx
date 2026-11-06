import { fireEvent, screen, within, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../render";
import CareerTimeline, { type Career } from "../../src/components/admin/CareerTimeline";
import AdminCardLink from "../../src/components/admin/AdminCardLink";
import CareerPicker from "../../src/components/admin/CareerPicker";
import { api } from "../../src/api/client";

vi.mock("../../src/api/client", () => ({ api: { get: vi.fn(), post: vi.fn() }, errMsg: String }));
const tenure = { team: "Liquid", teamId: "Liquid", game: "csgo", start: "2016-01-02", end: "2016-04-21", status: "active", precision: "day", rawDates: "2016-01-02 – 2016-04-21", source: "https://liquipedia.net/counterstrike/Example", verified: false };
const career: Career = { page: tenure.source, observedAt: "2026-10-24", sourceRevision: "source-revision", locked: false, tenures: [tenure] };

describe("admin career inspection", () => {
  it("searches aliases, teams and exact IDs, filters disabled records, and directly selects a result", () => {
    const onSelect = vi.fn();
    renderWithProviders(<CareerPicker players={[
      {playerId:1,nickname:"First",enabled:true,revision:1,career:{...career,aliases:["old-name"]}},
      {playerId:2,nickname:"Second",enabled:false,revision:1,career:null},
    ]} onSelect={onSelect} />);
    const search = screen.getByRole("searchbox");
    fireEvent.change(search,{target:{value:"oldname"}});
    fireEvent.click(screen.getByRole("button",{name:/First #1/}));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({playerId:1}));
    fireEvent.change(search,{target:{value:"Liquid"}});
    expect(screen.getByRole("button",{name:/First #1/})).toBeInTheDocument();
    fireEvent.change(search,{target:{value:"#2"}});
    expect(screen.queryByRole("button",{name:/Second/})).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("资料筛选"),{target:{value:"all"}});
    expect(screen.getByRole("button",{name:/Second #2/})).toBeInTheDocument();
  });
  it("keeps complete history available while filtering inspection issues", () => {
    renderWithProviders(<CareerTimeline career={{...career,tenures:[tenure,{...tenure,team:"Uncertain",teamId:"Uncertain",start:"2018-01-01",end:"2019-01-01",precision:"year"}]}} />);
    fireEvent.click(screen.getByRole("button",{name:/仅看待核对/}));
    expect(screen.queryByText("Liquid")).not.toBeInTheDocument();
    expect(screen.getByText("Uncertain")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"全部任期"}));
    expect(screen.getByText("Liquid")).toBeInTheDocument();
  });
  it("shows protected manual evidence separately from original source text", () => {
    renderWithProviders(<CareerTimeline career={{ ...career, syncWarnings: ["Source conflict"], tenures: [{ ...tenure, manual: { fields: ["start"], source: "https://www.hltv.org/player/1/example", checkedAt: "2026-10-24", note: "Mar 2014 - Jun 2015" } }] }} />);
    expect(screen.getByText("人工补充（受保护）")).toBeInTheDocument();
    fireEvent.click(screen.getByText("人工补充（受保护）"));
    expect(screen.getByRole("link", { name: "补充依据 ↗" })).toHaveAttribute("href", "https://www.hltv.org/player/1/example");
    expect(screen.getByText(tenure.rawDates)).toBeInTheDocument();
    expect(screen.getByText("Source conflict")).toBeInTheDocument();
  });
  it("shows every tenure, including repeated teams, original dates and full calculation bounds", () => {
    renderWithProviders(<CareerTimeline career={{ ...career, tenures: Array.from({ length: 80 }, () => ({ ...tenure })) }} />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(81);
    expect(within(table).getAllByText("Liquid")).toHaveLength(80);
    expect(within(table).getAllByText(tenure.rawDates)).toHaveLength(80);
    expect(within(table).getAllByText("2016-01-02")).toHaveLength(80);
    expect(within(table).getAllByText("2016-04-21")).toHaveLength(80);
  });

  it("distinguishes Present cutoff, uncertain dates and unknown values", () => {
    renderWithProviders(<CareerTimeline career={{ ...career, tenures: [
      { ...tenure, end: "2026-10-25", rawDates: "2016-01-02 – Present" },
      { ...tenure, start: "2015-12-31", end: null, precision: "year", rawDates: "2015 – ?", status: "unknown" },
    ] }} />);
    expect(screen.getByText(/采集截点，非离队日/)).toBeInTheDocument();
    expect(screen.getByText(/采集时仍在队，截至 · 2026-10-24/)).toBeInTheDocument();
    expect(screen.getByText("2026-10-25")).toBeInTheDocument();
    expect(screen.getByText("日期不完整，请核对原文")).toBeInTheDocument();
    expect(screen.getByText("2015 – ?")).toBeInTheDocument();
    expect(screen.getAllByText("未知").length).toBeGreaterThanOrEqual(2);
  });

  it("distinguishes missing approved data from an empty source", () => {
    const view = renderWithProviders(<CareerTimeline career={null} />);
    expect(screen.getByText(/尚无已批准/)).toBeInTheDocument();
    view.rerender(<CareerTimeline career={{ ...career, tenures: [] }} />);
    expect(screen.getByText("已入库，但来源未提供任期记录。")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("flags conservative bounds that leave no valid interval without hiding the source entry", () => {
    renderWithProviders(<CareerTimeline career={{ ...career, tenures: [{ ...tenure, start: "2014-12-31", end: "2014-09-09", precision: "year", rawDates: "2014-??-?? — 2014-09-09" }] }} />);
    expect(screen.getByText(/边界无有效区间，不用于队友计算/)).toBeInTheDocument();
    expect(screen.getByText("2014-??-?? — 2014-09-09")).toBeInTheDocument();
  });

  it("loads approved data, keeps drafts on player switching and never rebases a stale edit on refresh", async () => {
    const rows = [{ playerId: 1, nickname: "First", enabled: true, revision: 1, career }, { playerId: 2, nickname: "Second", enabled: true, revision: 1, career: null }];
    vi.mocked(api.get).mockImplementation(async (url) => ({ data: url.includes("reviews") ? [] : rows }));
    vi.mocked(api.post).mockResolvedValue({ data: {} });
    const view = renderWithProviders(<AdminCardLink />);
    fireEvent.click(await screen.findByRole("button", { name: /First #1/ }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {target:{value:"First"}});
    view.rerender(<AdminCardLink tab="reviews" />);
    await screen.findByText("暂无待审核资料。");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    view.rerender(<AdminCardLink tab="careers" />);
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue("First"));
    fireEvent.change(screen.getByRole("searchbox"), {target:{value:""}});
    fireEvent.click(screen.getByText(/高级：编辑 JSON/));
    const edit = screen.getByRole("textbox", { name: "任期资料" });
    const draft = JSON.stringify({ ...career, locked: true });
    fireEvent.change(edit, { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: /Second #2/ }));
    expect(screen.getByText(/尚无已批准/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /First #1/ }));
    expect(screen.getByRole("textbox", { name: "任期资料" })).toHaveValue(draft);
    rows[0].revision = 2;
    view.rerender(<AdminCardLink tab="reviews" />);
    view.rerender(<AdminCardLink tab="careers" />);
    await screen.findByText(/#1 · v2/);
    fireEvent.click(screen.getByRole("button", { name: "提交审核" }));
    expect(api.post).toHaveBeenCalledWith("/admin/card-link/careers", expect.objectContaining({ expectedRevision: 1, career: { ...career, locked: true } }));
  });
});

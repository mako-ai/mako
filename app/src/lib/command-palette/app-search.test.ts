import { describe, expect, it } from "vitest";
import {
  appPaletteItems,
  folderLabel,
  mergeAppResults,
  rankAppsLocally,
  type PaletteApp,
} from "./app-search";

const apps: PaletteApp[] = [
  {
    id: "a",
    title: "Leads by canton",
    description: "Inbound leads per canton",
    path: "apps/Sales/CH/leads",
    owner: "jonas",
  },
  {
    id: "b",
    title: "Quotas",
    description: "Agent quotas and leads targets",
    path: "apps/Sales/quotas",
    owner: "maria",
  },
  { id: "c", title: "Churn radar", path: "users/joan/apps/churn" },
];

describe("palette app search", () => {
  it("matches title, description, folder and owner instantly", () => {
    expect(rankAppsLocally(apps, "churn", {}, 5).map(a => a.id)).toEqual(["c"]);
    expect(rankAppsLocally(apps, "maria", {}, 5).map(a => a.id)).toEqual(["b"]);
    expect(rankAppsLocally(apps, "sales ch", {}, 5).map(a => a.id)).toEqual([
      "a",
    ]);
    expect(rankAppsLocally(apps, "", {}, 5)).toEqual([]);
  });

  it("ranks a title hit over a description hit, usage breaking ties", () => {
    expect(rankAppsLocally(apps, "leads", {}, 5).map(a => a.id)).toEqual([
      "a",
      "b",
    ]);
    const tie: PaletteApp[] = [
      { id: "x", title: "Leads A" },
      { id: "y", title: "Leads B" },
    ];
    expect(
      rankAppsLocally(tie, "leads", { y: { score: 12 } }, 5).map(a => a.id),
    ).toEqual(["y", "x"]);
  });

  it("lets the server's answer lead, keeping local-only hits after it", () => {
    const local = [apps[0], apps[1]];
    expect(mergeAppResults(local, null, 5).map(a => a.id)).toEqual(["a", "b"]);
    expect(
      mergeAppResults(local, [apps[2], apps[1]], 5).map(a => a.id),
    ).toEqual(["c", "b", "a"]);
    expect(mergeAppResults(local, [apps[2]], 1).map(a => a.id)).toEqual(["c"]);
  });

  it("puts the server's related apps after every word match", () => {
    const related: PaletteApp = { id: "r", title: "Related", related: true };
    expect(
      mergeAppResults([apps[0]], [related, apps[2]], 5).map(a => a.id),
    ).toEqual(["c", "a", "r"]);
  });

  it("labels the folder, not the app, and builds runnable items", () => {
    expect(folderLabel("apps/Sales/CH/leads")).toBe("Sales / CH");
    expect(folderLabel("apps/leads")).toBeUndefined();
    expect(folderLabel("users/joan/apps/churn")).toBe("Personal");
    const [item] = appPaletteItems([apps[0]], "Apps");
    expect(item.subtitle).toBe("Sales / CH · jonas");
    expect(item.section).toBe("Apps");
    expect(typeof item.run).toBe("function");
  });
});

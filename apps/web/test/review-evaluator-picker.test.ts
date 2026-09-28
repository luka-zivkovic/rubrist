import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@rubrist/shared";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node"] as const) vi.stubGlobal(name, (dom.window as any)[name]);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const api = vi.hoisted(() => ({ fetchSkillVersions: vi.fn(), createReviewQueue: vi.fn(), navigate: vi.fn() }));
const state = vi.hoisted(() => ({ dashboard: null as { skill: Skill } | null }));
vi.mock("@/lib/api", () => api);
vi.mock("@/components/ui/card", () => Object.fromEntries(["Card","CardHeader","CardTitle","CardDescription","CardContent"].map(name=>[name,({children,...props}:any)=>createElement("div",props,children)])));
vi.mock("@/components/ui/button", () => ({Button:({children,variant,...props}:any)=>createElement("button",props,children)}));
vi.mock("@/components/ui/input", () => ({Input:(props:any)=>createElement("input",props)}));
vi.mock("@/components/rubrist", () => ({Eyebrow:({children}:any)=>createElement("span",null,children)}));
vi.mock("@/lib/criterion-scope", async()=>import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/dashboard-context", () => ({ useDashboard: () => state }));
vi.mock("react-router-dom", () => ({ useNavigate: () => api.navigate }));
vi.mock("@/hooks/use-dialog-focus", () => ({ useDialogFocus: () => ({ current: null }) }));
const { SaveQueueModal } = await import("../src/components/save-queue-modal.js");
const v1 = { id:"v1",skillId:"skill1",version:"0.1.0",criterionVersionId:"cv1" };
const v2 = { id:"v2",skillId:"skill1",version:"0.2.0",criterionVersionId:"cv2" };
const skill = { id:"skill1",currentVersion:v2 } as Skill;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if(root) await act(async()=>root!.unmount()); root=undefined; document.body.innerHTML=""; state.dashboard=null; vi.clearAllMocks(); });
afterAll(()=>{dom.window.close();vi.unstubAllGlobals();});
async function render() {
  if(!root) { const container=document.createElement("div");document.body.appendChild(container);root=createRoot(container); }
  await act(async()=>root!.render(createElement(SaveQueueModal,{caseIds:["case1"],defaultName:"Review",context:"Selected cases",onClose:vi.fn()})));
}
describe("queue evaluator selection",()=>{
  it("saves the explicitly selected historical evaluator and its definition",async()=>{
    state.dashboard={skill};api.fetchSkillVersions.mockResolvedValue([v2,v1]);api.createReviewQueue.mockResolvedValue({id:"queue1"});
    await render();
    const select=document.querySelector("select")!;
    await act(async()=>{select.value="v1";select.dispatchEvent(new dom.window.Event("change",{bubbles:true}));});
    const create=[...document.querySelectorAll("button")].find((b)=>b.textContent?.includes("Create queue"))!;
    await act(async()=>create.click());
    expect(api.createReviewQueue).toHaveBeenCalledWith({name:"Review",description:"Selected cases",caseIds:["case1"],skillVersionId:"v1",criterionVersionId:"cv1"});
    expect(api.navigate).toHaveBeenCalledWith("/review-queues/queue1");
  });
  it("initializes after dashboard load and clears old versions when the criterion changes",async()=>{
    api.fetchSkillVersions.mockResolvedValue([v2,v1]);
    await render();
    expect([...document.querySelectorAll("button")].find((b)=>b.textContent?.includes("Create queue"))!.disabled).toBe(true);
    state.dashboard={skill};await render();expect(document.querySelector("select")!.value).toBe("v2");
    const nextVersion={id:"next",skillId:"skill2",version:"0.1.0",criterionVersionId:"next_cv"};
    api.fetchSkillVersions.mockResolvedValue([nextVersion]);state.dashboard={skill:{id:"skill2",currentVersion:nextVersion} as Skill};
    await render();expect(document.querySelector("select")!.value).toBe("next");
    expect([...document.querySelectorAll("option")].map(o=>o.value)).toEqual(["next"]);
  });
});

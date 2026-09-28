import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";
import { PROJECT_SWITCH_EVENT } from "../../lib/project-switch.js";

export const settingsInput = "h-9 w-full min-w-0 rounded-sm border border-rule bg-card-2 px-3 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60";
export type FormState = { dirty: boolean; busy: boolean };
export type ReportFormState = (section: string, state: FormState) => void;
export interface SettingsFormProps { canEdit: boolean; reportState: ReportFormState }

export function useSettingsFormState(section: string, dirty: boolean, busy: boolean, report: ReportFormState) {
  useEffect(() => { report(section, { dirty, busy }); }, [section, dirty, busy, report]);
  useEffect(() => () => report(section, { dirty: false, busy: false }), [section, report]);
}

export function useSettingsNavigationGuard(dirty: boolean, busy: boolean) {
  const state = useRef({ dirty, busy });
  state.current = { dirty, busy };
  const confirmDiscard = () => {
    if (state.current.busy) return false;
    return !state.current.dirty || window.confirm("Leave these settings? Unsaved changes and any new key you have not copied will be lost.");
  };
  useBlocker(({ currentLocation, nextLocation }) =>
    (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search) && !confirmDiscard()
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!state.current.dirty && !state.current.busy) return;
      event.preventDefault(); event.returnValue = "";
    };
    const switchProject = (event: Event) => {
      if (!confirmDiscard()) event.preventDefault();
      else state.current = { dirty: false, busy: false };
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener(PROJECT_SWITCH_EVENT, switchProject);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener(PROJECT_SWITCH_EVENT, switchProject);
    };
  }, []);
  return { confirmDiscard, allowExit: () => { state.current = { dirty: false, busy: false }; } };
}

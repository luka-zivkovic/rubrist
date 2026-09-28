/** Ask mounted editors before changing the project pin used by every API call. */
export const PROJECT_SWITCH_EVENT = "rubrist:before-project-switch";
export function confirmProjectSwitch(): boolean {
  return window.dispatchEvent(new Event(PROJECT_SWITCH_EVENT, { cancelable: true }));
}

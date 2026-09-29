import type { JudgeModel, JudgeProviderAvailabilityItem, JudgeProviderId } from "@rubrist/shared";
import { BindingSettings, type useBindingPicker } from "../screens/skill-edit/binding-settings.js";

export function FirstRunJudgePicker(props: {
  provider: JudgeProviderId; providers: JudgeProviderAvailabilityItem[];
  modelId: string; modelVersion: string; baseUrl: string; models: JudgeModel[];
  loading: boolean; error: string | null; disabled: boolean;
  temperature: string; temperatureValid: boolean; canCheck: boolean;
  picker: ReturnType<typeof useBindingPicker>;
  onProvider: (value: JudgeProviderId) => void;
  onModel: (id: string, version: string) => void;
  onBaseUrl: (value: string) => void;
}) {
  const { picker, provider } = props;
  const pending = picker.checkPending || picker.temperaturePending;
  const inputClass = "mt-1 h-9 w-full rounded-sm border border-rule-soft bg-card px-2 text-[12px] text-ink";
  return <fieldset disabled={props.disabled} className="rounded-sm border border-rule-soft bg-card-2 p-3">
    <legend className="px-1 text-[13px] font-medium">Judge model</legend>
    <p className="mb-3 text-[12px] text-ink-2">Choose a configured provider and model. Checking its settings uses a few small API calls.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-[12px]">Provider
        <select aria-label="Judge provider" className={inputClass} value={provider} onChange={(event) => props.onProvider(event.target.value as JudgeProviderId)}>
          {!props.providers.some((option) => option.provider === provider && option.available) ? <option value={provider} disabled>{provider} · unavailable</option> : null}
          {props.providers.filter((option) => option.available).map((option) => <option key={option.provider} value={option.provider}>{option.label}</option>)}
        </select>
      </label>
      {provider === "custom" ? <>
        <label className="text-[12px]">Model ID<input aria-label="Custom judge model ID" className={inputClass} value={props.modelId} onChange={(event) => props.onModel(event.target.value, event.target.value.trim())} /></label>
        <label className="text-[12px]">Model version<input aria-label="Custom judge model version" className={inputClass} value={props.modelVersion} onChange={(event) => props.onModel(props.modelId, event.target.value)} /></label>
        <label className="text-[12px]">Base URL<input aria-label="Custom judge base URL" className={inputClass} value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
      </> : <label className="text-[12px]">Model
        <select aria-label="Judge model" className={inputClass} value={props.modelId} disabled={props.disabled || props.loading} onChange={(event) => {
          const selected = props.models.find((model) => model.id === event.target.value);
          if (selected) props.onModel(selected.id, selected.version);
        }}>
          {!props.modelId ? <option value="">{props.loading ? "Loading models…" : "Choose a model"}</option> : null}
          {props.modelId && !props.models.some((model) => model.id === props.modelId) ? <option value={props.modelId}>{props.modelId} · configured</option> : null}
          {props.models.map((model) => <option key={model.id} value={model.id}>{model.label === model.id ? model.id : `${model.label} · ${model.id}`}</option>)}
        </select>
      </label>}
    </div>
    {props.error ? <p role="alert" className="mt-2 text-[12px] text-signal">{props.error}</p> : null}
    <p role="status" className="mt-3 text-[12px] text-ink-2">{pending ? "Checking model settings before you create the evaluator…" : picker.checkError ? "The model check could not finish. Open model settings to retry; any saved settings still need confirmation." : picker.blockingProblems.length > 0 ? "Adjust the model settings below before creating the evaluator." : picker.report ? "Model settings checked. The exact configuration will also be confirmed after saving." : "Model settings will be confirmed after saving."}</p>
    <details className="mt-3" open={picker.blockingProblems.length > 0 || Boolean(picker.checkError)}>
      <summary className="cursor-pointer text-[12px] text-ink-2">Model settings and check details</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <BindingSettings provider={provider} temperature={props.temperature} temperatureValid={props.temperatureValid} picker={picker} canCheck={props.canCheck} />
      </div>
    </details>
  </fieldset>;
}

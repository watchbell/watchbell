import { PlainTable } from "@/components/plain-table";
import { AlertSev } from "@/components/severity";
import { Src } from "@/components/sources";
import { Status } from "@/components/status";
import { type ListRow, rowClass, td } from "@/components/table";
import { RULE_NAMES, RULES, type RuleConfig } from "@/lib/alerts/catalog";
import { stepText } from "@/lib/alerts/compose";
import type { MessageTemplates } from "@/lib/alerts/message-template";
import { clock, zoneLabel } from "@/lib/time";
import { ruleState } from "@/lib/view/alerts";
import { RuleActions } from "./rule-dialog";

const HEAD = ["Rule", "Severity", "Condition", "State", ""];

// Owners edit and switch rules (spec §10); everyone else reads them.
// `templates` and `now` (1.2.4): each rule's custom message texts, and the sample time and next steps for the dialog's preview.
export function RulesTable({ rules, owner, templates, now }: { rules: { rule: RuleConfig; firing: number; hasData: boolean }[]; owner: boolean; templates: MessageTemplates; now: Date }) {
  const since = `${clock(now)} ${zoneLabel(now)}`;
  const rows: ListRow[] = rules.map(({ rule, firing, hasData }) => {
    const def = RULES[rule.key];
    const s = ruleState({ enabled: rule.enabled, firing, hasData });
    return {
      key: rule.key,
      state: rule.severity,
      text: `${RULE_NAMES[rule.key]} ${rule.key}`,
      row: (
        <tr className={rowClass}>
          <td className={td}><b className="font-medium">{RULE_NAMES[rule.key]}</b> <span className="font-mono text-[11px] text-ink-faint">{rule.key}</span><Src kind={def.source} /></td>
          <td className={td}><AlertSev severity={rule.severity} /></td>
          <td className={`${td} text-ink-soft`}>{def.condition(rule.threshold)}</td>
          <td className={td}><Status state={s.state}>{s.text}</Status></td>
          <td className={td}>{owner && <RuleActions rule={rule} condition={def.condition(rule.threshold)} templates={templates[rule.key] ?? {}} sample={{ since, step: { en: stepText(rule.key, "en"), id: stepText(rule.key, "id") } }} />}</td>
        </tr>
      ),
    };
  });
  return <PlainTable head={HEAD} rows={rows} />;
}

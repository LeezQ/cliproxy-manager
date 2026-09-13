import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '@/features/config/types';
import { SectionCard } from '@/features/config/components/SectionCard';
import {
  FieldAnchor,
  FieldGrid,
  ToggleRow,
} from '@/features/config/components/fields/FieldPrimitives';
import {
  QuotaSwitchPreviewModelToggle,
  QuotaSwitchProjectToggle,
} from '@/features/config/components/fields/sharedFields';

/** 04 配额回退：配额耗尽时的回退策略（两个开关默认 true）。 */
export function SectionQuota({ values, disabled, onChange }: ConfigSectionProps) {
  const { t } = useTranslation();

  return (
    <SectionCard
      title={t('config_management.visual.sections.quota.title')}
      description={t('config_management.visual.sections.quota.description')}
    >
      <FieldGrid>
        <QuotaSwitchProjectToggle values={values} disabled={disabled} onChange={onChange} />
        <QuotaSwitchPreviewModelToggle values={values} disabled={disabled} onChange={onChange} />
        <FieldAnchor fieldId="quotaAntigravityCredits">
          <ToggleRow
            title={t('config_management.visual.sections.quota.antigravity_credits')}
            checked={values.quotaAntigravityCredits}
            disabled={disabled}
            onChange={(quotaAntigravityCredits) => onChange({ quotaAntigravityCredits })}
          />
        </FieldAnchor>
      </FieldGrid>
    </SectionCard>
  );
}

import { useTranslation } from 'react-i18next';
import type { ConfigSectionProps } from '@/features/config/types';
import { getValidationMessage } from '@/features/config/components/blocks/shared';
import { SectionCard } from '@/features/config/components/SectionCard';
import { FieldGrid, FieldStack } from '@/features/config/components/fields/FieldPrimitives';
import {
  ApiKeysField,
  DebugToggle,
  HostField,
  LoggingToFileToggle,
  PortField,
  ProxyUrlField,
  QuotaSwitchPreviewModelToggle,
  QuotaSwitchProjectToggle,
  SponsorHintSpacer,
} from '@/features/config/components/fields/sharedFields';

/**
 * 「常用」tab：原简单模式的 8 个高频字段，别名视图（不占分区序号）。
 * 渲染源与正典分区共享（sharedFields），数据同为 useVisualConfig 一份状态。
 */
export function SectionCommon({
  values,
  validationErrors,
  disabled,
  onChange,
}: ConfigSectionProps) {
  const { t } = useTranslation();
  const portError = getValidationMessage(t, validationErrors?.port);

  return (
    <SectionCard
      title={t('config_management.visual.sections.common.title')}
      description={t('config_management.visual.sections.common.description')}
    >
      <FieldStack>
        <FieldGrid>
          <HostField
            values={values}
            disabled={disabled}
            onChange={onChange}
            topExtra={<SponsorHintSpacer />}
          />
          <PortField
            values={values}
            disabled={disabled}
            onChange={onChange}
            error={portError}
            topExtra={<SponsorHintSpacer />}
          />
          <ProxyUrlField values={values} disabled={disabled} onChange={onChange} />
        </FieldGrid>

        <ApiKeysField values={values} disabled={disabled} onChange={onChange} />

        <FieldGrid>
          <DebugToggle values={values} disabled={disabled} onChange={onChange} />
          <LoggingToFileToggle values={values} disabled={disabled} onChange={onChange} />
          <QuotaSwitchProjectToggle values={values} disabled={disabled} onChange={onChange} />
          <QuotaSwitchPreviewModelToggle values={values} disabled={disabled} onChange={onChange} />
        </FieldGrid>
      </FieldStack>
    </SectionCard>
  );
}

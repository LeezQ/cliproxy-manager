import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useVisualConfig } from '@/hooks/useVisualConfig';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import {
  CONFIG_MODE_STORAGE_KEY,
  CONFIG_SECTION_STORAGE_KEY,
  LEGACY_EDITOR_MODE_STORAGE_KEY,
  configPanelDomId,
  configTabDomId,
  type ConfigEditorMode,
  type ConfigTabId,
} from '@/features/config/constants';
import {
  CONFIG_FIELD_COUNT,
  buildHeaderMeta,
  countSectionErrors,
  countTotalErrors,
  readSavedMode,
  readSavedSection,
  resolveDirtyTabs,
  resolveStatus,
} from '@/features/config/uiState';
import {
  shouldReloadVisualDraft,
  useConfigDocument,
} from '@/features/config/hooks/useConfigDocument';
import { useFieldJump } from '@/features/config/hooks/useFieldJump';
import { useSourceSearch } from '@/features/config/hooks/useSourceSearch';
import { ConfigHeader } from '@/features/config/components/ConfigHeader';
import { ConfigSearch } from '@/features/config/components/ConfigSearch';
import { ConfigTabs } from '@/features/config/components/ConfigTabs';
import { DiffModal } from '@/features/config/components/DiffModal';
import { FloatingSaveBar } from '@/features/config/components/FloatingSaveBar';
import { ModeSwitch } from '@/features/config/components/ModeSwitch';
import { SourcePanel, SourceSearchBar } from '@/features/config/components/SourcePanel';
import { SectionAdvanced } from '@/features/config/components/sections/SectionAdvanced';
import { SectionCommon } from '@/features/config/components/sections/SectionCommon';
import { SectionConnectivity } from '@/features/config/components/sections/SectionConnectivity';
import { SectionLogging } from '@/features/config/components/sections/SectionLogging';
import { SectionNetwork } from '@/features/config/components/sections/SectionNetwork';
import { SectionPayload } from '@/features/config/components/sections/SectionPayload';
import { SectionQuota } from '@/features/config/components/sections/SectionQuota';
import { SectionStreaming } from '@/features/config/components/sections/SectionStreaming';
import styles from '@/features/config/ConfigPage.module.scss';

export function ConfigPage() {
  const { t } = useTranslation();
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.isCurrentLayer : true;
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const isMobile = useMediaQuery('(max-width: 768px)');

  const {
    visualValues,
    visualDirty,
    visualDirtyFields,
    visualParseError,
    visualValidationErrors,
    visualHasPayloadValidationErrors,
    loadVisualValuesFromYaml,
    applyVisualChangesToYaml,
    setVisualValues,
  } = useVisualConfig();

  const [mode, setMode] = useState<ConfigEditorMode>(() =>
    readSavedMode(localStorage.getItem(CONFIG_MODE_STORAGE_KEY))
  );
  const [activeSection, setActiveSection] = useState<ConfigTabId>(() =>
    readSavedSection(localStorage.getItem(CONFIG_SECTION_STORAGE_KEY))
  );
  // 旧「简单/完整」双模式已退役，清掉遗留的持久化键。
  useEffect(() => {
    localStorage.removeItem(LEGACY_EDITOR_MODE_STORAGE_KEY);
  }, []);

  const doc = useConfigDocument({
    mode,
    visualDirty,
    visualParseError,
    loadVisualValuesFromYaml,
    applyVisualChangesToYaml,
  });
  const sourceSearch = useSourceSearch();

  const disableControls = connectionStatus !== 'connected';
  const hasVisualModeError = !!visualParseError;
  const hasVisualValidationErrors =
    mode === 'visual' &&
    (Object.values(visualValidationErrors).some(Boolean) || visualHasPayloadValidationErrors);

  const unsavedChangesDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    }),
    [t]
  );

  useUnsavedChangesGuard({
    enabled: isCurrentLayer,
    shouldBlock: doc.isDirty,
    dialog: unsavedChangesDialog,
  });

  // YAML 解析失败：切换到源码模式；修复后仍可重试进入可视化模式。
  useEffect(() => {
    if (mode !== 'visual' || !visualParseError) return;

    setMode('source');
    localStorage.setItem(CONFIG_MODE_STORAGE_KEY, 'source');
    showNotification(
      t('config_management.visual_mode_unavailable_detail', { message: visualParseError }),
      'error'
    );
  }, [mode, showNotification, t, visualParseError]);

  // 可视化 ↔ 源码切换的 dirty 交接：
  // → 源码：物化可视化脏字段供查看，但不把同步动作记作用户源码编辑；
  // → 可视化：真正的源码草稿需重新解析；纯模式往返保留字段级 dirty 和并发合并策略。
  const handleModeChange = useCallback(
    (nextMode: ConfigEditorMode) => {
      if (nextMode === mode) return;

      if (nextMode === 'source') {
        if (visualDirty) {
          const nextContent = applyVisualChangesToYaml(doc.content);
          if (nextContent !== doc.content) {
            doc.syncContentFromVisual(nextContent);
          }
        }
      } else if (shouldReloadVisualDraft(doc.sourceDirty, visualParseError)) {
        const result = loadVisualValuesFromYaml(doc.content);
        if (!result.ok) {
          showNotification(
            t('config_management.visual_mode_unavailable_detail', { message: result.error }),
            'error'
          );
          return;
        }
      }

      setMode(nextMode);
      localStorage.setItem(CONFIG_MODE_STORAGE_KEY, nextMode);
    },
    [
      applyVisualChangesToYaml,
      doc,
      loadVisualValuesFromYaml,
      mode,
      showNotification,
      t,
      visualDirty,
      visualParseError,
    ]
  );

  const handleSectionChange = useCallback((sectionId: ConfigTabId) => {
    setActiveSection(sectionId);
    localStorage.setItem(CONFIG_SECTION_STORAGE_KEY, sectionId);
  }, []);

  const { jumpToField } = useFieldJump({
    values: visualValues,
    setActiveSection: handleSectionChange,
  });

  const errorCounts = useMemo(
    () => countSectionErrors(visualValidationErrors, visualHasPayloadValidationErrors),
    [visualHasPayloadValidationErrors, visualValidationErrors]
  );
  const dirtyTabs = useMemo(() => resolveDirtyTabs(visualDirtyFields), [visualDirtyFields]);
  const totalErrors = useMemo(
    () => countTotalErrors(visualValidationErrors, visualHasPayloadValidationErrors),
    [visualHasPayloadValidationErrors, visualValidationErrors]
  );

  const status = resolveStatus({
    disconnected: disableControls,
    loading: doc.loading,
    loadFailed: Boolean(doc.error),
    yamlError: hasVisualModeError,
    validationBlocked: hasVisualValidationErrors,
    saving: doc.saving,
    dirty: doc.isDirty,
  });
  const headerMeta = buildHeaderMeta({
    fieldCount: CONFIG_FIELD_COUNT,
    status,
    dirtyCount: visualDirtyFields.size,
    sourceDirty: doc.sourceDirty,
    errorCount: mode === 'visual' ? totalErrors : 0,
  });

  const saveDisabled =
    disableControls ||
    doc.loading ||
    doc.saving ||
    !doc.isDirty ||
    doc.diffModalOpen ||
    hasVisualModeError ||
    hasVisualValidationErrors;

  const sectionProps = {
    values: visualValues,
    validationErrors: visualValidationErrors,
    disabled: disableControls || doc.loading,
    onChange: setVisualValues,
  };

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'common':
        return <SectionCommon {...sectionProps} />;
      case 'connectivity':
        return <SectionConnectivity {...sectionProps} />;
      case 'network':
        return <SectionNetwork {...sectionProps} />;
      case 'logging':
        return <SectionLogging {...sectionProps} />;
      case 'quota':
        return <SectionQuota {...sectionProps} />;
      case 'streaming':
        return <SectionStreaming {...sectionProps} />;
      case 'advanced':
        return <SectionAdvanced {...sectionProps} />;
      case 'payload':
        return (
          <SectionPayload
            {...sectionProps}
            hasPayloadValidationErrors={visualHasPayloadValidationErrors}
          />
        );
    }
  };

  return (
    <div className={styles.page}>
      {/* 页头：标题/说明/计数 + 右侧「搜索 · 模式切换 · 重新加载」；搜索随模式切换为字段搜索或源码搜索 */}
      <ConfigHeader
        meta={headerMeta}
        reloadDisabled={doc.loading || doc.saving}
        reloading={doc.loading}
        onReload={doc.handleReload}
        extraActions={
          <>
            {mode === 'visual' ? (
              <ConfigSearch disabled={disableControls || doc.loading} onJump={jumpToField} />
            ) : (
              <SourceSearchBar search={sourceSearch} disabled={disableControls || doc.loading} />
            )}
            <ModeSwitch
              mode={mode}
              disabled={doc.saving || doc.loading}
              onChange={handleModeChange}
            />
          </>
        }
      />

      {doc.error && (
        <div className="error-box" role="alert">
          {doc.error}
        </div>
      )}
      {!doc.error && visualParseError && (
        <div className="error-box" role="alert">
          {t('config_management.visual_mode_unavailable_detail', { message: visualParseError })}
        </div>
      )}

      {mode === 'visual' ? (
        <div className={styles.visualEditor}>
          {/* 分区导航：下划线式 tabs，与下方分区卡片组成一个编辑区块 */}
          <div className={styles.tabsRow}>
            <ConfigTabs
              active={activeSection}
              errorCounts={errorCounts}
              dirtyTabs={dirtyTabs}
              disabled={doc.saving || doc.loading}
              onChange={handleSectionChange}
            />
          </div>
          <div
            className={styles.panel}
            role="tabpanel"
            id={configPanelDomId(activeSection)}
            aria-labelledby={configTabDomId(activeSection)}
          >
            {renderActiveSection()}
          </div>
        </div>
      ) : (
        <SourcePanel
          search={sourceSearch}
          value={doc.content}
          onChange={doc.handleChange}
          theme={resolvedTheme}
          editable={!disableControls && !doc.loading}
        />
      )}

      <FloatingSaveBar
        visible={isCurrentLayer && doc.isDirty}
        statusText={t(isMobile ? status.shortLabelKey : status.labelKey)}
        statusTone={status.tone}
        saving={doc.saving}
        saveDisabled={saveDisabled}
        discardDisabled={doc.loading || doc.saving}
        onSave={doc.handleSave}
        onDiscard={doc.handleDiscard}
      />

      <DiffModal
        open={doc.diffModalOpen}
        original={doc.serverYaml}
        modified={doc.mergedYaml}
        onConfirm={doc.handleConfirmSave}
        onCancel={doc.closeDiff}
        loading={doc.saving}
      />
    </div>
  );
}

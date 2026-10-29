---
description: Конвейер план → код → ревью → фикс через агентов pipeline, каждая стадия на своей модели
argument-hint: '<описание задачи>'
disable-model-invocation: true
---

Проведи задачу `$ARGUMENTS` через workflow плагина pipeline.

1. Вызови инструмент Workflow с `name: "pipeline:run"` и `args: { "task": "<текст задачи дословно>" }`. Если workflow по этому имени не находится, вызови его файлом: `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/run.js"` с теми же `args`. Сам агентов не запускай и код не пиши — всё делает workflow.
2. Результат со `status: "blocked"`: покажи пользователю `brief` коротко и список `blockingDecisions` (вопрос, варианты, рекомендация архитектора). Дождись ответов. Затем перезапусти workflow с `args: { "task": "<та же задача>", "decisions": "<ответы пользователя дословно>" }` и `resumeFromRunId` предыдущего запуска, чтобы карта кода не собиралась заново. До решения пользователя код не писать.
3. Результат со `status: "approved"`, `"approved_with_failing_checks"` или `"unresolved_findings"`: отчитайся по полям результата —
   - что изменено (`filesTouched`, `implementation`, `fixes`);
   - по каждому раунду ревью: подтверждённые и опровергнутые находки (`reviewRounds[].confirmed` / `refuted`), что осталось неисправленным (`unresolved`), минорные замечания (`minorFindings`);
   - проверки (`checks`): команда и результат как есть. Проверку с `fail` или `not_run` не называть пройденной. Если `checksNotRun` непустой — так и скажи.
4. Если `status: "error"` — покажи `message` и остановись.
5. Ничего не коммить и не пушить без явной просьбы пользователя.

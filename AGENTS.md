# Project Manifest

See `./manifest.md` for project metadata.

This file defines:
- `project_type`
- `project_priority`


## Pipeline Model Selection

- When a pipeline/API model choice arises, consult [GPT-5.6 Model Selection Guide](/Users/alexeykrolmini/Code/GPT-5.6-model-selection-guide-ru.md), map its **Model × Reasoning** recommendation to the provider/model supported by this project, and do not default to mini/nano by habit.
- For a cross-provider audit or model-refresh recommendation, read [Pipeline Model-Selection Handoff](/Users/alexeykrolmini/Code/CLAUDE_CODE_PIPELINE_MODEL_SELECTION_HANDOFF.md), ground it in live code and current official provider documentation, and return a read-only evaluation plan before changing any runtime route.

### Делегирование задач субагентам

При получении задачи от пользователя — сначала оценить:
- **Сам:** быстрые правки (< 2 мин), обсуждения, анализ, вопросы, мелкие фиксы
- **Субагент:** код > 50 строк, новые модули, рефакторинг, UI-изменения, исследования, любые задачи > 5 мин

При делегировании субагенту:
- Составить детальное ТЗ с контекстом, файлами для чтения, ожидаемым результатом
- Запустить в фоне
- Сообщить пользователю что запущено
- По завершении — дать краткий отчёт о результате
- Можно запускать несколько субагентов параллельно на независимые задачи

Цель: максимальная параллельность и минимальное время ожидания пользователя.

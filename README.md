**Оговорка!** Это не коммерческий проект, т.е. я не поддерживаю его в особо актуальном состоянии, я его просто использую сам. Иногда чего-то допиливаю, и даже не забываю комитить сюда. Поэтому просто скачивайте, поручайте ИИ разобраться и переделывайте под себя, как хотите. ИИ вам ответить на любой вопрос.

# News Digest Pipeline v2.0.4

[![Version](https://img.shields.io/badge/version-2.0.4-blue)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude API](https://img.shields.io/badge/Claude_API-Opus_4-d97706?logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![SQLite](https://img.shields.io/badge/SQLite-Database-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Telegram](https://img.shields.io/badge/Telegram-Bot_API-0088cc?logo=telegram&logoColor=white)](#)
[![Facebook](https://img.shields.io/badge/Facebook-Graph_API-1877f2?logo=facebook&logoColor=white)](#)

> Автоматизированный пайплайн: собирает новости → генерирует авторские комментарии через Claude API → публикует в Telegram, Facebook, Instagram.
>
> Проект реализован в рамках учебного курса: **Создание ИИ Агентов и приложений для бизнеса, роста, дохода и кайфа.** Хотите научиться делать такое же, а не смотреть как баран на новые ворота? Попробуйте этот курс. 14 дней пробный период: **https://alexeykrol.com/ai_full/**

---

<p align="center">
  <img src="docs/screenshots/dash.png" width="100%" alt="Dashboard" />
</p>

---

## Как это работает

1. У вас установлено приложение **[Perplexity](https://perplexity.ai)** на телефоне — в нём есть удобный дайджест новостей (Discover)
2. Вы открываете Perplexity, переходите в Discover и прокручиваете новости
3. Понравилась новость — нажимаете **«Поделиться»** → **Telegram** → выбираете вашего бота
4. Когда накопилось **13+ статей** — Claude API автоматически генерирует дайджест, и на дашборде появляется готовый текст с кнопками публикации
5. Заходите в **Dashboard**, находите нужный дайджест и нажимаете куда хотите опубликовать: **📨 TG** (Telegram), **📘 FB** (Facebook) или оба

Без ручного копирования, без вёрстки, без рутины.

**Примеры готовых дайджестов:**
[Facebook](https://www.facebook.com/alex.v.krol/posts/pfbid02oj14ZFeSvyrrpcNN8dBJoJ6YsegA4gSeqtsSdhVMjkAYZU15aFuRH7msPN3EuE8al) ・ [Telegram](https://t.me/alexkrol/8510) ・ [YouTube](http://youtube.com/post/UgkxFs7bfPTzCMBtYq_UT2ttLd6TVNRenVRL?si=olNJLuQs_ZVqlarq)

---

## Что нужно до запуска

| Шаг | Что сделать | Инструкция |
|-----|------------|-----------|
| 1 | Настроить **VPS-сервер** (Ubuntu, Docker, Traefik) | [vps-setup.md](news-digest-pipeline/docs/vps-setup.md) |
| 2 | Создать **Telegram-бота** через @BotFather и настроить webhook | [telegram-setup.md](news-digest-pipeline/docs/telegram-setup.md) |
| 3 | Получить **Claude API ключ** на [console.anthropic.com](https://console.anthropic.com/) | — |
| 4 | *(опционально)* Создать **Facebook App** и получить Page Access Token | [facebook-page-setup.md](news-digest-pipeline/docs/facebook-page-setup.md) |
| 5 | Заполнить `.env` файл и запустить `docker compose up -d` | [Быстрый старт](#быстрый-старт) |

---

## Архитектура

```mermaid
graph TB
    subgraph "📱 Вход"
        A[iPhone / Telegram] -->|URL ссылки| B[Telegram Bot]
        A2[Chrome Extension] -->|JSON batch| C[API]
    end

    subgraph "☁️ VPS"
        B --> D[(SQLite)]
        C --> D
        E[Queue Manager<br/>каждые 60 сек] -->|13+ статей?| F[Claude API]
        D --> E

        F -->|Phase A: комментарий| G[Opus 4]
        G -->|Phase B: сборка| H[Готовый дайджест]
        H --> I[(SQLite)]
        I --> J[Dashboard]
    end

    subgraph "📤 Публикация"
        J -->|📨 TG| O[Telegram канал]
        J -->|📘 FB| P[Facebook Page]
        J -->|📋 Copy| Q[Буфер обмена]
    end

    subgraph "🖥️ Mac"
        L[local-fetcher.js] -->|Chrome| D
    end

    style A fill:#0088cc,color:#fff
    style F fill:#d97706,color:#fff
    style J fill:#059669,color:#fff
    style O fill:#0088cc,color:#fff
    style P fill:#1877f2,color:#fff
```

---

## Быстрый старт

### 1. Форк и клонирование

```bash
git clone https://github.com/YOUR_USERNAME/news.git
cd news/news-digest-pipeline
```

### 2. Настройка

```bash
cp .env.example .env
```

Заполните `.env`:

```env
# Обязательные
NODE_ENV=production                 # На сервере обязательно (иначе авторизация отключится)
ANTHROPIC_API_KEY=sk-ant-...        # Claude API ключ
TELEGRAM_BOT_TOKEN=123456:ABC...    # Токен от @BotFather
TELEGRAM_CHAT_ID=123456789          # Ваш Telegram user ID
TELEGRAM_WEBHOOK_SECRET=...          # Обязателен для приёма новостей из Telegram

# Опционально (для публикации)
TELEGRAM_PUBLISH_CHAT_ID=-100...   # ID канала для публикации
FACEBOOK_PAGE_ID=...               # ID Facebook Page
FACEBOOK_PAGE_ACCESS_TOKEN=...     # Page Access Token

# Безопасность
API_SECRET_KEY=...                 # Сгенерируйте: openssl rand -base64 32
DASHBOARD_PASSWORD=...             # Отдельный пароль для дашборда
```

### 3. Запуск

Для локальной разработки — `npm run dev` (авторизация отключена, `NODE_ENV=development`):

```bash
npm install
npm run dev
```

Дашборд: `http://localhost:3000` (локально всё открыто — редактирование без логина).

В production запускайте с `NODE_ENV=production` — авторизация включена, гости видят дашборд только на чтение, редактирование после логина (`admin` / ваш `DASHBOARD_PASSWORD`):

```bash
NODE_ENV=production npm start
```

### 4. Production (Docker)

```bash
docker compose up -d --build
```

---

## Как работает генерация

```mermaid
flowchart LR
    subgraph "Phase A — Комментарии"
        A1[Статья 1] -->|prompt.md| C1[Claude Opus]
        A2[Статья 2] -->|prompt.md| C2[Claude Opus]
        A3[Статья N] -->|prompt.md| C3[Claude Opus]
        C1 --> R1[80-150 слов]
        C2 --> R2[ироничный тон]
        C3 --> R3[скептика]
    end

    subgraph "Phase B — Сборка"
        R1 --> ASM[Claude Opus]
        R2 --> ASM
        R3 --> ASM
        CFG[config.md] --> ASM
        ASM --> DIGEST["#новости  1. ...<br/>2. ...<br/>Курс<br/>Граница<br/>Хэштеги"]
    end

    style C1 fill:#d97706,color:#fff
    style C2 fill:#d97706,color:#fff
    style C3 fill:#d97706,color:#fff
    style ASM fill:#d97706,color:#fff
    style DIGEST fill:#059669,color:#fff
```

Два промпта управляют стилем:
- **[prompt.md](prompt.md)** — как писать комментарий (тон, длина, формат)
- **[assembly_prompt.md](assembly_prompt.md)** — как собирать дайджест (порядок, курс, подвал)
- **[config.md](config.md)** — хэштеги, упоминание курса, граница

---

## Dashboard

| Функция | Описание |
|---------|----------|
| 👁 **Смотреть** | Превью первых 3 новостей |
| 📨 **TG** | Публикация в Telegram канал |
| 📘 **FB** | Публикация на Facebook Page |
| 📋 **Копировать** | Текст в буфер обмена |
| ✕ **Удалить** | Удалить дайджест |
| **Статус** | Черновик / Опубликован (с датой) |

Дашборд публичен на чтение (гости видят только безопасные поля, без внутренних метрик и идентификаторов); редактирование, генерация и публикация доступны после логина. Записи защищены server-side: проверка кред на каждую мутацию + rate limiting.

---

## Facebook: только Page, не личный профиль

> **⚠️ Почему автопубликация в личный профиль УДАЛЕНА из проекта**
>
> Автоматическая публикация в **личный профиль** Facebook через browser automation (Patchright, Playwright, Puppeteer, Selenium) **приводит к silent ban аккаунта**. Facebook детектирует автоматизацию и без предупреждения начинает удалять все ваши посты — даже те, которые вы публикуете вручную. При этом Account Quality остаётся чистым, никакого уведомления о нарушении нет.
>
> **Что мы обнаружили на собственном опыте:**
> - Тестовые посты через browser automation (особенно с текстом вроде «test», «automation») вызвали срабатывание спам-фильтра
> - Фильтр распространился на ВСЕ публикации с аккаунта — включая ручные
> - Ограничение затронуло даже второй аккаунт с того же IP
> - Восстановление заняло 3-7 дней полного молчания
>
> **Именно поэтому автопубликация в личный профиль удалена из проекта.** Поддерживается только **Facebook Page через Graph API** — другой, безопасный механизм модерации.

**Как публиковать безопасно:**
- **Facebook Page через API** — поддерживается в проекте (Graph API, безопасно)
- **Telegram** — поддерживается (Bot API, безопасно)
- **Личный профиль** — только вручную: скопируйте текст с дашборда (📋) и опубликуйте сами

Полное исследование проблемы: [facebook-shadow-ban-research.md](news-digest-pipeline/docs/facebook-shadow-ban-research.md)

---

## Медиа-пайплайны (в разработке)

### Instagram (изображения)

```mermaid
flowchart LR
    D[Дайджест] --> H[Claude Opus<br/>5-step headlines]
    H --> T[Заголовок + буллеты]
    TPL[Шаблон-референс] --> IMG[fal.ai / Recraft V3]
    T --> OVR[Sharp: текст на плашке]
    IMG --> OVR
    OVR --> FINAL[1080×1350 PNG]
    FINAL --> IG[Instagram API]

    style H fill:#d97706,color:#fff
    style IMG fill:#7c3aed,color:#fff
    style FINAL fill:#059669,color:#fff
```

### Video (Reels / Shorts)

```mermaid
flowchart LR
    D[Дайджест] --> S[Claude: Storyboard<br/>6 shots × 5-15 сек]
    S --> V[Kling 3.0 / Veo 3.1]
    V --> C1[shot_01.mp4]
    V --> C2[shot_02.mp4]
    V --> C3[shot_N.mp4]
    C1 --> FF[FFmpeg concat]
    C2 --> FF
    C3 --> FF
    FF --> R[reel_final.mp4<br/>1080×1920]

    style S fill:#d97706,color:#fff
    style V fill:#7c3aed,color:#fff
    style R fill:#059669,color:#fff
```

---

## API

**Модель доступа:**

- **Чтение (`GET`) — публичное.** Анонимным вызовам публичные `GET` отдают только безопасные поля (внутренние — стоимость, токены, id внешних постов, логи генерации, telegram-идентификаторы — скрыты). Аутентифицированный владелец (сессия дашборда **или** `Authorization: Bearer <API_SECRET_KEY>`) видит полные данные.
- **Записи (`POST` / `PATCH` / `DELETE`)** требуют `Authorization: Bearer <API_SECRET_KEY>` или сессию дашборда.

| Метод | Endpoint | Описание |
|-------|----------|----------|
| `GET` | `/health` | Статус сервера (публичный) |
| `GET` | `/` | Dashboard — публичный, только чтение для гостей, редактирование после логина |
| `POST` | `/api/articles` | Добавить статью по URL |
| `POST` | `/api/articles/batch` | Пакетная загрузка |
| `GET` | `/api/articles` | Список статей (публичный, безопасные поля) |
| `GET` | `/api/articles/stats` | Статистика |
| `POST` | `/api/digests/generate` | Ручная генерация |
| `GET` | `/api/digests` | Список дайджестов (публичный, безопасные поля) |
| `GET` | `/api/digests/:id/text` | Чистый текст |
| `POST` | `/api/digests/:id/publish` | Публикация `{platforms: ["telegram","facebook"]}` |
| `DELETE` | `/api/digests/:id` | Удалить дайджест |
| `GET` | `/api/source-posts` | Список source-постов (публичный, безопасные поля) |
| `POST` | `/api/source-posts/fetch-url` | Добавить FB-пост по ссылке (browserless) |

---

## Безопасность

- **Модель доступа:** публичное чтение (только безопасные поля) + аутентифицированные записи (Bearer-токен или сессия дашборда).
- **Fail-closed авторизация:** на сервере обязателен `NODE_ENV=production`. Авторизация отключается ТОЛЬКО при явном `NODE_ENV=development` или `test` (для локальной разработки без трения). Любое другое значение, опечатка или пустое — авторизация ВКЛючена (защита от «тихого» открытия API при мисконфиге).
- **Только Bearer-токен для API** — query-параметр `?key=` убран (он утекал в логи Traefik/morgan).
- **Rate limiting:** 30 req/min (API), 10 неудачных попыток записи / 15 мин на IP (до проверки кред — защита от перебора), 20 попыток логина / 15 мин, 60 req/min (Telegram webhook).
- **Security-заголовки на всех ответах:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security` (в production). Заголовок `X-Powered-By` отключён.
- **Единая валидация URL статей** (HTTPS + whitelist `perplexity.ai` + запрет управляющих символов, хранится нормализованный href) на всех входах (API, batch, Telegram) и в `local-fetcher.js` — закрывает инъекцию в AppleScript.
- **SSRF-защита:** whitelist только `perplexity.ai`.
- **Telegram webhook fail-closed:** требует `TELEGRAM_WEBHOOK_SECRET`; без секрета webhook отвергает все запросы (403).
- **Timing-safe** сравнение ключей.
- **Сессия дашборда:** HMAC-подписанная HttpOnly session cookie.
- `.env` не в git, права `0600`.

Полный аудит: [CODE_AUDIT_2026-07-16.md](CODE_AUDIT_2026-07-16.md) ・ [SECURITY_AUDIT_2026-04-13.md](SECURITY_AUDIT_2026-04-13.md)

---

## Структура

```
├── prompt.md                     # Промпт: комментарий к статье
├── assembly_prompt.md            # Промпт: сборка дайджеста
├── config.md                     # Хэштеги, курс, граница
│
├── news-digest-pipeline/
│   ├── src/
│   │   ├── index.js              # Express + auth + rate limiting
│   │   ├── middleware/auth.js    # Bearer + Basic Auth
│   │   ├── db/                   # SQLite (better-sqlite3)
│   │   ├── routes/               # API endpoints (+ public-dto.js — безопасные поля)
│   │   ├── services/             # Claude API, publishers, queue (+ url-validator.js)
│   │   └── public/index.html    # Dashboard
│   ├── scripts/
│   │   ├── local-fetcher.js      # Chrome content extraction
│   │   ├── monitor.sh            # VPS monitoring
│   │   └── setup-cron.sh         # Cron setup
│   ├── production/
│   │   └── image/                # Instagram image pipeline
│   ├── docs/                     # Setup guides
│   ├── Dockerfile
│   └── docker-compose.yml
│
└── extension/                    # Chrome extension
```

---

## Документация

| Тема | Файл |
|------|------|
| Telegram (бот + канал) | [telegram-setup.md](news-digest-pipeline/docs/telegram-setup.md) |
| Facebook Page (Graph API) | [facebook-page-setup.md](news-digest-pipeline/docs/facebook-page-setup.md) |
| VPS + Docker + Traefik | [vps-setup.md](news-digest-pipeline/docs/vps-setup.md) |
| iOS Shortcut | [ios-shortcut-setup.md](news-digest-pipeline/docs/ios-shortcut-setup.md) |
| Instagram Pipeline | [instagram/README.md](news-digest-pipeline/instagram/README.md) |

---

## Стек

| Компонент | Технология |
|-----------|-----------|
| Backend | Node.js 20, Express, SQLite |
| AI | Claude API (Opus 4), Anthropic SDK |
| Images | fal.ai, Recraft V3, Sharp |
| Video | Kling 3.0, Veo 3.1, FFmpeg |
| Извлечение контента | Реальный Chrome через AppleScript (local-fetcher) + browserless fetch (FB) |
| Deploy | Docker, Traefik, Ubuntu 24.04 |
| Notifications | Ntfy.sh |

---

## Лицензия

MIT

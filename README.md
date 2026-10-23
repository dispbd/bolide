# Alloy (рабочее название)

Экспериментальный Node.js/TypeScript-фреймворк, который соединяет:

- **структуру Nest.js**: модули, сервисы, внедрение зависимостей, но на функциях, без обязательных декораторов;
- **встроенные возможности Meteor.js**: auth, данные, реактивность и, главное, optimistic UI через изоморфные мутаторы;
- **лёгкость Total.js**: маленькое ядро на Web-стандартах, минимум зависимостей, один типизированный конфиг.

Исследование и обоснование: см. отчёт «Nest, Meteor и Total.js» в проекте.

## Ветки

| Ветка | Что внутри |
|---|---|
| `main` | Описание проекта и roadmap. Фазы вливаются сюда после завершения. |
| `phase-0` | Исследование и спайки. |
| `phase-0-<задача>` | Тяжёлые подзадачи фазы, вливаются в ветку фазы. Через дефис, потому что git не даёт завести `phase-0/...` рядом с веткой `phase-0`. |
| `phase-N` | Следующие фазы, по одной ветке на фазу. |

## Roadmap

См. [docs/roadmap.md](docs/roadmap.md).

## Запуск прототипа фазы 0

Нужны Node 22+, Docker и Postgres 16 (бинарники в `/usr/lib/postgresql/16/bin` или путь в `PGBIN`).

```bash
npm install
npm run db:up        # Postgres :54321 (wal_level=logical) + Electric :3000
npm test             # юнит-тесты мутаторов
npm run test:int     # два клиента через настоящий Electric
npm run bench        # задержки optimistic / подтверждения
npm run bundle-size  # размеры бандлов
npm run db:down
```

Итоги фазы: [docs/phase-0/results.md](docs/phase-0/results.md). Решение по ядру: [docs/adr/0001-core-on-hono.md](docs/adr/0001-core-on-hono.md).

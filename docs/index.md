# Local Agent Gateway User Guide

Local Agent Gateway は、外部ツールからローカルの agent ワークフローへ安全に作業を委譲するための個人用 Gateway API です。

このガイドは API 利用者と運用者向けです。Codex App Server 本体の JSON-RPC、ローカルファイルシステムの絶対パス、作業ディレクトリは公開 API に出さない前提で運用します。

## できること

- 許可済みリポジトリだけを対象に Codex タスクを作成する。
- `read-only` または `workspace-write` の範囲でタスクの権限を制限する。
- API トークンにスコープと有効期限を付ける。
- タスクの状態、要約、変更ファイル一覧を Gateway の `taskId` で確認する。
- 許可済み repo のタスク一覧を確認し、repo や status で絞り込む。
- `workspace-write` タスクを repo 単位で直列化しながら、`read-only` タスクは並行実行する。
- Codex アカウント状態を確認し、ChatGPT device-code login を開始する。
- 監査ログにはプロンプト本文ではなくハッシュと省略表示を残す。

## セキュリティ方針

- Codex App Server は内部 stdio プロセスとして実行し、JSON-RPC を直接公開しない。
- Gateway API は認証済みリクエストだけを受け付ける。
- `danger-full-access` は利用できない。
- 任意シェル実行 API は提供しない。
- App Server のファイルシステム API、コマンド API、`thread/shellCommand` は公開しない。
- Gateway API 経由で OpenAI API key や ChatGPT access token は受け取らない。
- トークンは作成時に一度だけ表示される。保存時はハッシュ化され、一覧 API でも生トークンは返らない。
- リポジトリはサーバー側の allowlist で解決する。クライアントから任意のパスは指定できない。
- 公開タスクレスポンスは Gateway の `taskId` を使い、Codex の内部スレッド ID は返さない。

インターネットへ直接ポートを開ける運用は避け、Tailscale、Cloudflare Tunnel、VPN、または同等の identity-aware な経路で公開してください。

## 初期セットアップ

必要なもの:

- Node.js 24
- npm

依存関係をインストールします。

```bash
npm install
```

環境変数の雛形をコピーします。

```bash
cp .env.example .env
```

`.env` で最低限次を設定します。

| 変数 | 用途 |
| --- | --- |
| `HOST` | バインドするホスト。既定は `127.0.0.1`。 |
| `PORT` | API ポート。既定は `8787`。 |
| `DATABASE_PATH` | SQLite データベースの保存先。 |
| `APP_BACKEND` | 実行バックエンド。既定は `codex-app-server`。 |
| `CODEX_APP_SERVER_COMMAND` | 起動する Codex CLI コマンド。既定は `codex`。 |
| `CODEX_APP_SERVER_MODEL` | 任意。`codex app-server -c model=...` に渡す model override。ローカル Codex 設定の既定 model がアカウントや CLI と合わない場合に固定する。 |
| `CODEX_APP_SERVER_TURN_TIMEOUT_MS` | App Server の turn 完了待ちタイムアウト。 |
| `CODEXGW_MAX_PARALLEL_READ_TASKS` | 並行実行できる read-only タスク数。既定は `4`。超過分はプロセス内キューで待機する。 |
| `CODEXGW_ALLOWED_REPOS_JSON` | Gateway が操作できるリポジトリ allowlist。production では必須。 |
| `TOKEN_PEPPER` | トークンハッシュ用の長いランダム秘密値。production では既定値不可。 |
| `BOOTSTRAP_ADMIN_TOKEN` | 初回トークン作成用の一時管理トークン。production では設定不可。 |

`CODEXGW_ALLOWED_REPOS_JSON` は JSON 配列で設定します。`id` は API や `repo:<repoId>` スコープに出る公開名、`path` はサーバー内だけで使う絶対パスです。

```json
[
  {
    "id": "local-agent-gateway",
    "path": "/absolute/path/to/local-agent-gateway",
    "defaultMode": "read-only",
    "allowedModes": ["read-only", "workspace-write"]
  }
]
```

開発サーバーを起動します。

```bash
npm run dev
```

ヘルスチェック:

```bash
curl http://127.0.0.1:8787/healthz
```

実 Codex 実行環境に接続せず、MVP の公開 API 契約だけを確認する場合は smoke check を実行します。

```bash
npm run smoke
```

この確認は in-memory database と fake Codex runner を使い、health check、初回トークン作成、スコープ付きリポジトリ一覧、タスク作成、タスク polling、内部 Codex thread ID を公開しないことを検証します。

## 初回トークン作成

初回だけ `BOOTSTRAP_ADMIN_TOKEN` を使って管理用 API トークンを作成します。このトークンに `token:*` スコープを含めておくと、`BOOTSTRAP_ADMIN_TOKEN` を削除した後も通常のトークン管理 API を使えます。

```bash
curl -X POST http://127.0.0.1:8787/v1/tokens \
  -H "Authorization: Bearer $BOOTSTRAP_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "admin",
    "scopes": [
      "task:create",
      "task:read",
      "task:control",
      "audit:read",
      "token:create",
      "token:read",
      "token:revoke",
      "codex:account:read",
      "codex:account:login",
      "codex:account:logout",
      "repo:local-agent-gateway",
      "mode:read-only",
      "mode:workspace-write"
    ],
    "expiresInDays": 90
  }'
```

レスポンスの `token` は一度しか表示されません。保存後、`BOOTSTRAP_ADMIN_TOKEN` は `.env` から削除してください。

## スコープ

スコープはトークンができることを制限します。

| スコープ | 意味 |
| --- | --- |
| `task:create` | タスクを作成できる。 |
| `task:read` | タスクや許可済みリポジトリを読める。 |
| `task:control` | 別トークンが作成した active task を制御できる。作成者本人の制御には不要。 |
| `audit:read` | 監査ログ一覧を読める。 |
| `token:create` | 新しいトークンを作成できる。 |
| `token:read` | トークン一覧を読める。生トークンは返らない。 |
| `token:revoke` | トークンを失効できる。 |
| `codex:account:read` | Codex アカウント状態を読める。 |
| `codex:account:login` | ChatGPT device-code login を開始またはキャンセルできる。 |
| `codex:account:logout` | Codex からログアウトできる。 |
| `repo:<repoId>` | 指定リポジトリを対象にできる。 |
| `mode:read-only` | 読み取り専用タスクを作成できる。 |
| `mode:workspace-write` | workspace-write タスクを作成できる。 |

`thread:create` と `thread:write` は互換性のために有効なスコープとして扱われますが、現行 API の主要操作は `task:*` を使います。

通常トークンは、自分が持っていないスコープを子トークンへ付与できません。また、子トークンの有効期限は発行元トークンの有効期限を超えられません。

## リポジトリ一覧

呼び出し元トークンが `repo:<repoId>` スコープを持つリポジトリだけを返します。

```bash
curl http://127.0.0.1:8787/v1/repos \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

レスポンス例:

```json
{
  "repos": [
    {
      "id": "local-agent-gateway",
      "defaultMode": "read-only"
    }
  ]
}
```

## Provider 一覧

利用可能な task provider と公開 capability を確認できます。backend 名、transport、内部 payload は返しません。

```bash
curl http://127.0.0.1:8787/v1/providers \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

レスポンス例:

```json
{
  "providers": [
    {
      "id": "codex",
      "label": "Codex",
      "capabilities": {
        "readOnly": true,
        "workspaceWrite": true,
        "streamEvents": true,
        "diffArtifacts": true,
        "accountAuth": true,
        "cancel": true,
        "steer": true,
        "models": false
      }
    }
  ]
}
```

## Codex アカウント認証

Codex アカウント操作は App Server の `account/*` を Gateway 内部から呼び出します。レスポンスには API key、access token、refresh token、raw JSON-RPC payload は含めません。

アカウント状態確認:

```bash
curl http://127.0.0.1:8787/v1/codex/account \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

ChatGPT device-code login 開始:

```bash
curl -X POST http://127.0.0.1:8787/v1/codex/account/login/device-code \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

レスポンスの `verificationUrl` を開き、`userCode` を入力します。進行中のログインを取り消す場合は `loginId` を指定します。

```bash
curl -X POST http://127.0.0.1:8787/v1/codex/account/login/cancel \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "loginId": "login_..." }'
```

ログアウト:

```bash
curl -X POST http://127.0.0.1:8787/v1/codex/account/logout \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## タスク作成

タスク作成には `task:create`、`repo:<repoId>`、`mode:<mode>` が必要です。`mode` を省略すると、サーバー側で定義された対象リポジトリの既定モードが使われます。

`POST /v1/tasks` は Codex の実行完了を待たず、`202 Accepted` と Gateway の `taskId` を返します。外部ツールはこの `taskId` を保存し、`GET /v1/tasks/:id` を polling して `completed` または `failed` を確認します。

`workspace-write` タスクは repo ごとに 1 件ずつ実行されます。同じ repo で write タスクが実行中の場合、後続の write タスクは `queued` 状態で作成され、前の write タスクが完了または失敗した後に `pending` へ進みます。`read-only` タスクは write タスクの待機列に入らず並行実行できますが、`CODEXGW_MAX_PARALLEL_READ_TASKS` を超える分は `queued` になります。

Gateway はプロンプト本文と Codex runner handle を永続化しません。起動時に前回プロセスから残った `queued` または `pending` タスクがある場合、それらは復旧不能な未完了タスクとして `failed` に整理されます。

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "local-agent-gateway",
    "prompt": "READMEを読んで改善案を出してください",
    "mode": "read-only"
  }'
```

レスポンス例:

```json
{
  "taskId": "task_...",
  "status": "pending",
  "repo": "local-agent-gateway",
  "mode": "read-only",
  "summary": "",
  "changedFiles": [],
  "createdAt": "2026-05-05T00:00:00.000Z",
  "completedAt": null,
  "error": null
}
```

プロンプトは 1 文字以上 20,000 文字以下です。リクエストボディに未知のフィールドを含めると検証エラーになります。

## タスク確認

タスク作成者本人は、`task:create` で作成した自分のタスクを `task:read` なしで確認できます。別トークンで読む場合は `task:read` と対象タスクの `repo:<repoId>` スコープが必要です。

```bash
curl http://127.0.0.1:8787/v1/tasks/task_... \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

完了後は `status`、`summary`、`changedFiles`、`completedAt`、`error` を確認します。

タスク一覧:

```bash
curl 'http://127.0.0.1:8787/v1/tasks?repo=local-agent-gateway&status=completed&limit=20' \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

`GET /v1/tasks` は `task:read` を要求し、呼び出し元が `repo:<repoId>` scope を持つ repo のタスクだけを返します。query は `repo`、`status` (`queued`、`pending`、`completed`、`failed`)、`limit` を受け付けます。

完了レスポンス例:

```json
{
  "taskId": "task_...",
  "status": "completed",
  "repo": "local-agent-gateway",
  "mode": "read-only",
  "summary": "task completed",
  "changedFiles": ["README.md"],
  "createdAt": "2026-05-05T00:00:00.000Z",
  "completedAt": "2026-05-05T00:00:05.000Z",
  "error": null
}
```

## タスクイベント

CLI tool、Web dashboard、desktop app、mobile app、automation bot、MCP integration、CI helper などの外部クライアントは、Gateway の task event を Server-Sent Events として取得できます。認可は `GET /v1/tasks/:id` と同じで、タスク作成者本人、または `task:read` と対象 repo scope を持つトークンだけが読めます。

```bash
curl http://127.0.0.1:8787/v1/tasks/task_.../events \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Accept: text/event-stream"
```

イベントは正規化済みの `task.queued`、`task.started`、`task.interrupted`、`task.steered`、`agent.message.completed`、`file.changed`、`diff.available`、`task.completed`、`task.failed` などです。レスポンスには Gateway `taskId` だけを含め、Codex 内部 thread ID、raw `cwd`、App Server の raw JSON-RPC payload は含めません。再取得時は `Last-Event-ID` header を指定すると、そのIDより後のイベントだけを取得できます。

実行中タスクの場合、イベント endpoint は保存済みイベントを replay した後も接続を開いたままにし、新しい Gateway event を terminal event まで配信します。この live fan-out はプロセス内状態なので、Gateway 再起動後のクライアントは `Last-Event-ID` で保存済みイベントを再取得してください。再起動前に未完了だったタスクは `task.failed` として記録されます。

## タスク制御

active task は Gateway の `taskId` で interrupt / steer できます。作成者本人は自分の active task を制御できます。別トークンが制御する場合は `task:read`、`task:control`、対象 repo scope が必要です。`queued`、`completed`、`failed`、または Gateway 再起動後に active session handle が失われた task は `CONFLICT` になります。

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks/task_.../interrupt \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```bash
curl -X POST http://127.0.0.1:8787/v1/tasks/task_.../steer \
  -H "Authorization: Bearer $CODEXGW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "message": "Please focus on tests before editing docs." }'
```

`steer.message` は 1 文字以上 2,000 文字以下です。監査ログと task event には全文を保存せず、hash と omitted preview だけを残します。公開 API は Codex 内部 thread ID、turn ID、raw App Server payload を受け取りません。

## Diff Artifact

外部クライアントは、汎用task artifactとして差分を取得できます。認可は `GET /v1/tasks/:id` と同じです。Gatewayはallowlist済みrepo pathをserver-sideで解決し、task完了時に保存したartifactを返します。clientからraw path、任意git引数、shell command、workspace rootは渡せません。

```bash
curl http://127.0.0.1:8787/v1/tasks/task_.../diff \
  -H "Authorization: Bearer $CODEXGW_TOKEN"
```

レスポンスは Gateway `taskId`、repo ID、status、repo-relative `changedFiles`、scrub済み `patch`、`truncated`、artifact `createdAt` を返します。Codex内部thread IDやraw `cwd`は含めません。`/diff` はrequest時のlive worktreeを読みません。

## 監査ログ

`GET /v1/audit-logs` は `audit:read` が必要です。query は `action`、`repo`、`status` (`success`、`failure`)、`taskId`、`limit` を受け付けます。raw token、token hash、full prompt、full steering text は返しません。

```bash
curl 'http://127.0.0.1:8787/v1/audit-logs?action=tasks:create&limit=20' \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

外部クライアント統合の設計方針は [`CLIENT_INTEGRATION.md`](CLIENT_INTEGRATION.md)、event stream の詳細は [`EVENT_STREAMING.md`](EVENT_STREAMING.md)、workspace target の将来設計は [`WORKSPACE_TARGETS.md`](WORKSPACE_TARGETS.md)、task control のguardrailは [`TASK_CONTROL.md`](TASK_CONTROL.md) を参照してください。

## トークン管理

トークン作成:

```bash
curl -X POST http://127.0.0.1:8787/v1/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "readonly-client",
    "scopes": [
      "task:create",
      "task:read",
      "repo:local-agent-gateway",
      "mode:read-only"
    ],
    "expiresInDays": 30
  }'
```

トークン一覧:

```bash
curl http://127.0.0.1:8787/v1/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

トークン失効:

```bash
curl -X DELETE http://127.0.0.1:8787/v1/tokens/tok_... \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## エラー形式

エラーは次の形式で返ります。

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Forbidden"
  }
}
```

代表的なエラー:

| code | 主な原因 |
| --- | --- |
| `UNAUTHORIZED` | Authorization ヘッダーがない、形式が違う、トークンが無効。 |
| `FORBIDDEN` | 必要なスコープがない。 |
| `CONFLICT` | task が active ではない、または active session handle が利用できない。 |
| `VALIDATION_ERROR` | リクエストボディやパラメータが不正。 |
| `TOKEN_EXPIRED` | トークンの有効期限切れ。 |
| `TOKEN_REVOKED` | トークンが失効済み。 |
| `REPO_NOT_ALLOWED` | allowlist にないリポジトリを指定した。 |
| `MODE_NOT_ALLOWED` | 対象リポジトリで許可されていないモードを指定した。 |
| `CODEX_NOT_CONFIGURED` | Codex 実行環境が未設定。 |
| `CODEX_EXECUTION_FAILED` | Codex タスク実行に失敗した。 |

## 運用チェックリスト

- production では `TOKEN_PEPPER` を長いランダム値に変更する。
- production では `BOOTSTRAP_ADMIN_TOKEN` を設定しない。
- production では `CODEXGW_ALLOWED_REPOS_JSON` に公開してよい `repoId` とサーバー内の実パスを明示する。
- `CODEXGW_MAX_PARALLEL_READ_TASKS` をローカルマシンの CPU、メモリ、Codex 利用量に合わせて調整する。
- 外部公開時は API の前段に認証・アクセス制御レイヤーを置く。
- トークンは用途ごとに短い有効期限と最小スコープで発行する。
- `workspace-write` は必要なクライアントだけに付与する。
- Codex アカウント操作スコープは管理者用トークンだけに付与する。
- `audit:read` と `task:control` は管理者または明確に信頼した automation のみに付与する。
- 監査ログとサーバーログに機密値が出ていないことを定期的に確認する。

## Codex Harness

このリポジトリには [`s-hiraoku/codex-harnesses`](https://github.com/s-hiraoku/codex-harnesses) から、プロジェクトローカルで使うハーネスを同梱しています。

| パス | 用途 |
| --- | --- |
| `AGENTS.md` | Codex に渡すリポジトリ固有の作業ルール。 |
| `policy_template.md` | Codex 作業で守る仕様・安全・品質ゲートのテンプレート。 |
| `policies/*.yaml` | strict/default/experimental の安全・検証ポリシー例。 |
| `docs/QUALITY.md` | 実用運用に向けた品質ゲート、確認観点、既知制限。 |
| `scripts/verify.sh` | lint/typecheck/test/build をまとめて実行する検証入口。 |
| `scripts/checkpoint.sh` | `codex/ledger/current.md` へ作業チェックポイントを追記する補助スクリプト。 |
| `codex/skills/` | bug fix、feature、review、release check などの再利用ワークフロー。 |
| `codex/hooks/` | secret guard、dangerous command guard、stop verify のサンプルhook。 |
| `codex/ledger/` | 長期作業の判断・リスク・検証ログ。 |

hook payload はサンプルです。Codex の lifecycle hook として使う場合は、対象環境に合わせて確認してから登録してください。

## GitHub Pages で公開する

このリポジトリは GitHub Actions で `docs/` 配下の Jekyll site をビルドし、GitHub Pages に公開します。

1. GitHub の repository settings を開く。
2. `Pages` を開く。
3. `Build and deployment` の source が `GitHub Actions` になっていることを確認する。
4. `main` に docs または `.github/workflows/pages.yml` の変更を push する。
5. `Deploy GitHub Pages` workflow の完了後、表示された Pages URL にアクセスする。

このガイドは workflow 内の Jekyll build で Markdown から HTML に変換されます。

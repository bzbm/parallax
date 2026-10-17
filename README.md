# parallax

Minimal multi-account switcher for AI chats
One window, a thin sidebar of dots, instant switching

## layout

- Claude 1-9, each with its own saved login
- ChatGPT, DeepSeek

## features

- Switch with the sidebar or the shortcuts in the Account menu (Cmd+1 to Cmd+9 for Claude)
- Only the 2 most recently used accounts stay loaded in RAM, every launch starts on fresh chats
- Cmd+N opens a new chat in the active account

## run

```
npm install
npm start
```

## build (apple silicon)

```
npm run build
cp -R dist/mac-arm64/Parallax.app /Applications/
```

Requires node 22 LTS. Node 26 broke Electron's installer on my machine.
The app is unsigned, so on first launch right-click it and choose Open.

## notes

- Logins live in the app's local data folder, never in this repo
- Not affiliated with Anthropic, OpenAI or DeepSeek

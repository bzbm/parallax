# parallax

Minimal multi-account switcher for AI chats
One window, a thin sidebar of dots, instant switching

## layout

- Claude 1-9, each with its own saved login
- ChatGPT, DeepSeek
- Video, Progress notes, Shelf (always loaded)

## features

- Switch with the sidebar or the shortcuts in the Account menu (Cmd+1 to Cmd+9 for Claude)
- Only the 2 most recently used chat accounts stay loaded in RAM, every launch starts on fresh chats
- Cmd+N opens a new chat in the active account
- Video: paste a YouTube, Vimeo or direct link, or upload a file from your device
- Progress notes: keep the latest progress.md, Cmd+Shift+H copies it as a handoff prompt and jumps to the next account
- Shelf: a local folder (Documents/Parallax Shelf) for your resources and saved responses, drag files in and out

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

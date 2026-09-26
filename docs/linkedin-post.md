# LinkedIn-Post (Deutsch)

*Bild: `docs/social-card.png` (1200×630) — oder `docs/social-card-square.png`, wenn du
auf Mobilgeräten mehr Fläche willst.*

---

Ich hatte keine Lust mehr, für jede Idee den Laptop aufzuklappen.

Meine Coding-Agents laufen auf eigenen Servern, nicht lokal. Das ist gut so — nur das
Starten war jedes Mal dasselbe Ritual: einloggen, Ordner anlegen, tmux starten, Claude
Code starten, Remote Control aktivieren, Link aufs Handy kopieren.

Acht Schritte, bevor auch nur eine Zeile entsteht. Und Datenbank, Storage und ein freier
Port? Kamen immer später. Meistens genau dann, wenn sie störten.

Also habe ich mir einen Knopf gebaut.

Jetzt sind es drei Taps auf dem Handy: Server wählen, Namen eintippen, starten. Danach
existiert das Projekt, hat **eine eigene PostgreSQL-Datenbank, einen eigenen S3-Bucket
und einen reservierten Port** — und der Agent weiß das alles schon, weil die Zugangsdaten
in der `.env` und in einer generierten `AGENTS.md` stehen.

Ich muss meine eigene Umgebung nicht mehr erklären. Das war der eigentliche Gewinn.

Das Ganze ist Open Source (MIT). Wer mag, kann es gerne ausprobieren:

👉 github.com/dataAiOliver/nolaptop

Es braucht nur einen Linux-Server mit tmux und der Claude-CLI. `make check` sagt dir
vorher, was fehlt, und ändert nichts.

Ich habe es für mich gebaut, weil es mich schlicht genervt hat. Wenn es jemandem sonst
hilft: umso besser. Über Feedback freue ich mich sehr — was fehlt, was nervt, was ihr
anders machen würdet. Wer Lust hat mitzubauen, ist ebenso herzlich eingeladen.

Und ja: das nächste fragwürdige Nebenprojekt starte ich jetzt im Bus.

#OpenSource #DeveloperTools #ClaudeCode #SelfHosted #AI

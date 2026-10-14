# GTM QA Checker

Rozszerzenie Chrome (Manifest V3) działające na `tagmanager.google.com`: zbiera konfigurację kontenera z interfejsu GTM, a docelowo porównuje wersje, sprawdza reguły QA agencji i generuje raport Markdown z pomocą LLM.

## Uruchomienie

```bash
npm install
npm run build      # jednorazowy build do dist/
npm run dev        # build + watch
npm run typecheck
```

Chrome → `chrome://extensions` → włącz **Tryb dewelopera** → **Załaduj rozpakowane** → wskaż folder `dist/`.
Po każdym buildzie kliknij ikonę odświeżenia rozszerzenia i przeładuj kartę GTM.

Panel otwiera się przyciskiem **QA** w prawym dolnym rogu strony GTM albo ikoną rozszerzenia.
Zakładka **Dane** → „Wczytaj workspace” lub „Wczytaj” przy wersji pobiera komplet danych (listy + szczegóły encji).
Wszystkie zapytania wtyczki to wyłącznie GET – nie może niczego zmienić w kontenerze.

## Architektura

| Plik | Świat / kontekst | Rola |
|---|---|---|
| `src/injected/injected.ts` | strona (`world: MAIN`, `document_start`) | Przechwytuje odpowiedzi `fetch`/XHR GTM i przekazuje surowy tekst. Wykonuje tylko zapytania **GET** zlecone przez content script, wyłącznie do hostów widzianych w ruchu GTM. |
| `src/content/content.ts` | content script (izolowany) | Most do `injected.ts`, przepuszcza dane przez adapter, trzyma magazyn, montuje panel. |
| `src/adapters/gtmApiAdapter.ts` | — | **Jedyne miejsce ze znajomością formatu danych GTM.** Zdejmuje prefiks XSSI `)]}'`, wykrywa encje po kształcie (`tagId`, `triggerId`, `variableId`, `containerVersionId`) i normalizuje je do `shared/types.ts`. Obsługuje też plik eksportu kontenera. |
| `src/content/store.ts` | content script | Encje pogrupowane w zakresy: `workspace:N`, `version:N`, `import:plik`. |
| `src/content/panel/` | content script | Panel w Shadow DOM (bez wpływu na style GTM). |
| `src/background/serviceWorker.ts` | service worker | Przełączanie panelu; tu trafią wywołania API LLM. |

## Gdy GTM zmieni format danych

1. Panel → zakładka **Debug**. Jeśli przy przeglądaniu tagów odpowiedzi pokazują „brak encji GTM”, adapter przestał rozpoznawać format.
2. **Pobierz surowe dane (JSON)**: zawiera pełne odpowiedzi (dane kontenera, zostają lokalnie).
3. Popraw wyłącznie `src/adapters/gtmApiAdapter.ts`.

Awaryjnie zawsze działa **Import eksportu kontenera** (Administracja → Eksportuj kontener), bo ten format jest udokumentowany i stabilny.

## Status

- [x] Etap 1: struktura, przechwytywanie danych, adapter, panel (Dane / Ustawienia / Debug), import eksportu
- [x] Etap 1b: adapter dla wewnętrznego API GTM (`/api/accounts/…`), aktywne wczytywanie workspace'u i wersji, cache szczegółów po `entityVersion`, listy zmian wersji/workspace'u
- [x] Etap 2: Diff Engine (workspace vs wersja, zakres wersji, ostatnie N godzin) – `src/diff/`
- [x] Etap 3b: zgody = spójność dodatkowych zgód w obrębie platformy (nie wymóg konkretnych typów); taksonomia nazw z Task 12 (`src/qa/taxonomy.ts`) z sugerowaną nazwą; `event_id` jako pole deduplikacji
- [x] Etap 3c: nazwy szablonów (`cvt_…` → „Data Tag”, „FAST Conversion”); zwolnienie narzędzi wewnętrznych (FAST) z kontroli zgód; analiza SST (`src/qa/sst.ts`): trasy GA4 Bridge / Data Tag / inne, spójność serwera, omijanie sGTM, wersje i ścieżki Data Tag, event_id, user_data; PII w parametrach GA4
- [x] Etap 3: Linter – `src/qa/` (resolver zmiennych → źródło danych, spójność źródeł per zdarzenie, duplikaty zmiennych/tagów/celów, sGTM, typy danych, brakujące odwołania, konwersje, Consent Mode v2, nazewnictwo, higiena)
- [x] Etap 4: LLM w service workerze (`src/llm/`): Anthropic przez oficjalne SDK (domyślnie `claude-opus-5-5`, fallback po odmowie), OpenAI i Gemini przez REST; sanityzacja – tylko metadane, bez kodu Custom HTML/JS, sekretów i e-maili; podgląd wysyłanych danych w zakładce Raport
- [x] Etap 5: Raport Markdown (`src/report/markdown.ts`): podsumowanie (+ opcjonalnie AI), publikacje, tabela przesyłanych wartości (źródło, brutto/netto, typ, zgody), uwagi QA, routing SST, lista zmian; edycja, kopiowanie, pobranie .md
- [x] Wyjątki agencji (`src/shared/exceptions.ts`, `src/qa/suppress.ts`): „To nie błąd” przy uwagach QA (zakres: kontener / wszystkie), sekcja „Ukryte” z przywracaniem, zasady dla AI (domyślne + własne, „Zaznaczenie → wyjątek AI” w Raporcie); zapis lokalny, eksport JSON, import tylko dopisuje. Docelowo: wspólna baza dla zespołu (format pliku = format rekordów)
- [x] Języki EN (domyślny) / DE / PL (`src/i18n/`): przełącznik w nagłówku panelu i w Ustawieniach; po zmianie Diff/QA przeliczają się z pamięci (bez zapytań do GTM); raport i podsumowanie AI w wybranym języku; wyjątki dopasowywane po stałym kluczu (`Finding.key`), więc działają niezależnie od języka. Słowniki z kontrolą typów – brak tłumaczenia = błąd kompilacji
- [x] Raport: sekcja „Zakup – porównanie przesyłanych wartości” (`src/report/purchase.ts`) – wszystkie tagi zakupu w kontenerze, w każdej komórce zmienna → faktyczne źródło (value, currency, transaction_id, items, event_id), oznaczenie 🆕/✏️/⏸ i werdykt spójności per pole
- [x] Wygląd w barwach smarketer.group (`src/content/panel/styles.ts`): fiolet #340254, gradient #3C0A6D→#6E6EAA, lawenda #ae93d6, akcent #46b5fc; font Inter dołączony do wtyczki (`public/fonts`, licencja OFL w `Inter-LICENSE.txt`); znak marki w nagłówku; kafelki liczników w QA, karty uwag z paskiem wagi
- [x] Raport „jednym kliknięciem” (zakładka Raport → „Utwórz raport z moich zmian”): niezapisane zmiany workspace’u, a jeśli ich brak – ostatnia publikacja (poprzednia → najnowsza wersja); QA tylko na zmienionych elementach; raport kopiowany do schowka
- [x] Przypomnienia: dymek „kontener nie był sprawdzony” (po ~2 s, × ukrywa na sesję) oraz po kliknięciu Submit/Publish w GTM dymek „Publikujesz? Utwórz raport” (nie blokuje GTM; pomijany, gdy raport już powstał w tej karcie); czerwona kropka na przycisku przy uwagach krytycznych
- [ ] Pomysł na kolejny etap: agent AI w trybie Preview (Tag Assistant) – wyłapywanie i oznaczanie błędnych tagów na żywo

// Agency best practices for the Google tag settings in GTM (container → Settings), from the document
// "Google Tag Best Practices – Dokument Konfiguracyjny". Applies when analytics and e-commerce are
// implemented through GTM and the data layer.
//
// Settings are identified by GTM's activity publicId (CSS class `activity-slat--<id>` on the Settings
// page); singleton activities also have a fixed numeric id used in the route `/activities/<n>`.
import type { Lang } from '../i18n';

export type Recommendation = 'enable' | 'disable' | 'configure' | 'default';

type Text = Record<Lang, string>;

export interface SettingGuide {
  id: string;
  rec: Recommendation;
  /** Name of the setting as GTM shows it (English / German UI). */
  title: Text;
  /** Short recommendation shown on the badge and card, e.g. "Disable or strongly limit". */
  recText: Text;
  why: Text;
  verify?: Text;
}

/** Fixed route ids of GTM's singleton activities (`/activities/<n>`). */
export const ACTIVITY_ROUTE_IDS: Record<string, string> = {
  '2147480577': 'ogt_auto_events',
  '2147480578': 'ogt_cross_domain',
  '2147480579': 'ogt_1p_data_v2',
  '2147480581': 'ogt_data_extract',
  '2147480582': 'ogt_ga_send',
  '2147480583': 'ogt_referral_exclusion',
  '2147480584': 'ogt_session_timeout',
  '2147480585': 'ogt_cookie_settings',
  '2147480587': 'ogt_dma',
  '2147480594': 'ogt_consent_defaults',
  '2147480596': 'ogt_dtc',
};

export const SETTINGS_GUIDE: SettingGuide[] = [
  {
    id: 'ogt_auto_events',
    rec: 'disable',
    title: { en: 'Manage automatic event detection', de: 'Automatische Ereignisermittlung verwalten', pl: 'Zarządzanie automatycznym wykrywaniem zdarzeń' },
    recText: { en: 'Disable or strongly limit', de: 'Deaktivieren oder stark einschränken', pl: 'Wyłącz lub bardzo mocno ogranicz' },
    why: {
      en: 'GA4 automatic (enhanced) measurement tries to detect clicks, forms or scrolling by itself. When e-commerce and events are implemented through GTM, these automatic scripts can duplicate events or send wrong data.',
      de: 'Die automatische (erweiterte) Messung von GA4 versucht, Klicks, Formulare oder Scrollen selbst zu erkennen. Wenn E-Commerce und Ereignisse über GTM umgesetzt sind, können diese Skripte Ereignisse doppeln oder falsche Daten senden.',
      pl: 'Automatyczny pomiar GA4 próbuje sam wykrywać kliknięcia, formularze czy przewijanie. Jeśli wdrażasz e-commerce i zdarzenia przez GTM, te automatyczne skrypty mogą dublować zdarzenia lub wysyłać błędne dane.',
    },
    verify: {
      en: 'Open GA4 DebugView and check that a single action on the page (e.g. a button click) triggers exactly one event.',
      de: 'GA4 DebugView öffnen und prüfen, dass eine einzelne Aktion auf der Seite (z. B. ein Klick) genau ein Ereignis auslöst.',
      pl: 'Włącz GA4 DebugView i sprawdź, czy pojedyncza akcja na stronie (np. kliknięcie przycisku) wyzwala dokładnie jedno zdarzenie.',
    },
  },
  {
    id: 'ogt_cross_domain',
    rec: 'configure',
    title: { en: 'Configure your domains', de: 'Domains konfigurieren', pl: 'Konfiguracja domen' },
    recText: { en: 'Configure (if applicable)', de: 'Konfigurieren (falls zutreffend)', pl: 'Konfiguruj (jeśli dotyczy)' },
    why: {
      en: 'Required for cross-domain tracking. If the purchase path goes through another domain (e.g. shop.com → payment.com), enter both domains so the session is not lost.',
      de: 'Notwendig für domainübergreifendes Tracking. Läuft der Kaufprozess über eine andere Domain (z. B. shop.de → zahlung.de), beide Domains eintragen, damit die Sitzung nicht verloren geht.',
      pl: 'Niezbędne do śledzenia międzydomenowego (cross-domain tracking). Jeśli ścieżka zakupowa przechodzi przez inną domenę (np. sklep.pl → platnosc.pl), wpisz tu obie domeny, aby uniknąć utraty sesji.',
    },
    verify: {
      en: 'Navigate between the domains and make sure the URL of the target page contains the _gl=… parameter.',
      de: 'Zwischen den Domains wechseln und prüfen, dass die URL der Zielseite den Parameter _gl=… enthält.',
      pl: 'Przejdź między domenami i upewnij się, że w adresie URL docelowej strony pojawia się parametr _gl=….',
    },
  },
  {
    id: 'ogt_1p_data_v2',
    rec: 'enable',
    title: { en: 'Allow user-provided data capabilities', de: 'Funktionen für von Nutzern bereitgestellte Daten zulassen', pl: 'Dane przekazywane przez użytkownika' },
    recText: { en: 'Enable', de: 'Aktivieren', pl: 'Włącz' },
    why: {
      en: 'Enables Enhanced Conversions in Google Ads and sending hashed user data (email, phone). Improves conversion attribution accuracy.',
      de: 'Ermöglicht Enhanced Conversions in Google Ads und das Senden gehashter Nutzerdaten (E-Mail, Telefon). Verbessert die Genauigkeit der Conversion-Zuordnung.',
      pl: 'Umożliwia działanie Ulepszonych Konwersji (Enhanced Conversions) w Google Ads oraz wysyłanie zaszyfrowanych danych użytkownika (email, telefon). Zwiększa dokładność przypisywania konwersji.',
    },
    verify: {
      en: 'In GTM Preview check that the Google Ads tag hits carry the user data object (user_data).',
      de: 'In der GTM-Vorschau prüfen, ob die Google-Ads-Aufrufe das Nutzerdatenobjekt (user_data) enthalten.',
      pl: 'W podglądzie GTM sprawdź, czy w wywołaniach taga Google Ads przesyłany jest obiekt z danymi użytkownika (user_data).',
    },
  },
  {
    id: 'ogt_ga_send',
    rec: 'disable',
    title: { en: 'Collect Universal Analytics events', de: 'Universal Analytics-Ereignisse erfassen', pl: 'Przechwytywanie zdarzeń UA' },
    recText: { en: 'Disable', de: 'Deaktivieren', pl: 'Wyłącz' },
    why: {
      en: 'Tries to capture old ga() Universal Analytics calls. UA has been shut down, so this only adds load in the browser and noise in the data.',
      de: 'Versucht, alte ga()-Aufrufe von Universal Analytics abzufangen. UA wurde eingestellt – die Option belastet nur den Browser und bringt Chaos in die Daten.',
      pl: 'Próbuje przechwytywać stare wywołania skryptu ga() Universal Analytics. Ponieważ UA zostało wyłączone, ta opcja niepotrzebnie obciąża przeglądarkę i wprowadza chaos w danych.',
    },
  },
  {
    id: 'ogt_data_extract',
    rec: 'disable',
    title: { en: 'Extract data from your page', de: 'Daten von Ihrer Seite extrahieren', pl: 'Wyciąganie danych ze strony' },
    recText: { en: 'Disable – use the GTM data layer', de: 'Deaktivieren – GTM-Datenschicht nutzen', pl: 'Wyłącz (używaj Data Layer w GTM)' },
    why: {
      en: 'The automatic HTML scanner often picks up wrong email addresses or form data. Passing user data directly from the data layer in GTM is much safer and more precise.',
      de: 'Der automatische HTML-Scanner greift oft falsche E-Mail-Adressen oder Formulardaten ab. Nutzerdaten direkt aus der Datenschicht in GTM zu übergeben ist deutlich sicherer und genauer.',
      pl: 'Automatyczny skaner kodu HTML często wyciąga błędne adresy e-mail lub dane z formularzy. Zdecydowanie bezpieczniej i precyzyjniej jest przekazywać dane użytkownika bezpośrednio z Data Layer w GTM.',
    },
  },
  {
    id: 'ogt_ip_mark',
    rec: 'configure',
    title: { en: 'Define internal traffic', de: 'Internen Traffic definieren', pl: 'Definiowanie ruchu wewnętrznego' },
    recText: { en: 'Configure', de: 'Konfigurieren', pl: 'Konfiguruj' },
    why: {
      en: 'Lets you enter the IP addresses of the office or development team, so internal traffic can be filtered out of GA4 reports.',
      de: 'Hier die IP-Adressen von Büro oder Entwicklerteam eintragen, damit interner Traffic in GA4-Berichten herausgefiltert werden kann.',
      pl: 'Pozwala podać adresy IP biura lub zespołu deweloperskiego. Dzięki temu można odfiltrować ruch wewnętrzny w raportach GA4.',
    },
    verify: {
      en: 'In GA4 check that traffic from your IP has the parameter traffic_type = internal.',
      de: 'In GA4 prüfen, ob Traffic von der eigenen IP den Parameter traffic_type = internal hat.',
      pl: 'W GA4 sprawdź, czy ruch z Twojego IP ma przypisany parametr traffic_type = internal.',
    },
  },
  {
    id: 'ogt_referral_exclusion',
    rec: 'configure',
    title: { en: 'List unwanted referrals', de: 'Liste unerwünschter Verweise', pl: 'Wykluczenia witryn odsyłających' },
    recText: { en: 'Configure – add payment gateways', de: 'Konfigurieren – Zahlungsanbieter eintragen', pl: 'Konfiguruj (dodaj bramki płatności)' },
    why: {
      en: 'Enter the payment gateway domains here (e.g. paypal.com, klarna.com, payu.pl). This prevents the customer returning from the payment page from overwriting the original traffic source as a new referral.',
      de: 'Hier die Domains der Zahlungsanbieter eintragen (z. B. paypal.com, klarna.com). So überschreibt die Rückkehr des Kunden nach der Zahlung nicht die ursprüngliche Quelle als neuen Verweis.',
      pl: 'Wprowadź tutaj domeny bramek płatności (np. payu.pl, przelewy24.pl, paypal.com). Zapobiega to sytuacji, w której powrót klienta po płatności nadpisuje oryginalne źródło odwiedzin jako nowy odsyłacz.',
    },
  },
  {
    id: 'ogt_session_timeout',
    rec: 'default',
    title: { en: 'Adjust session timeout', de: 'Zeitüberschreitung für Sitzungen anpassen', pl: 'Czas trwania sesji' },
    recText: { en: 'Default (30 min) / adjust', de: 'Standard (30 Min.) / anpassen', pl: 'Domyślnie (30 min) / dostosuj' },
    why: {
      en: 'The default session timeout is 30 minutes. Consider extending it (e.g. to 2–4 hours) if the site has long forms or video content.',
      de: 'Standardmäßig endet eine Sitzung nach 30 Minuten. Bei langen Formularen oder Videoinhalten lohnt sich eine Verlängerung (z. B. auf 2–4 Stunden).',
      pl: 'Domyślny czas trwania sesji wynosi 30 minut. Warto go wydłużyć (np. do 2–4 godzin), jeśli serwis zawiera długie formularze lub materiały wideo.',
    },
  },
  {
    id: 'ogt_cookie_settings',
    rec: 'default',
    title: { en: 'Override cookie settings', de: 'Cookie-Einstellungen überschreiben', pl: 'Ustawienia plików cookie' },
    recText: { en: 'Default', de: 'Standard', pl: 'Domyślnie' },
    why: {
      en: 'Leave the defaults unless legal requirements or a specific domain architecture require a different cookie lifetime or prefix.',
      de: 'Standard beibehalten, außer rechtliche Vorgaben oder eine besondere Domain-Architektur erfordern eine andere Cookie-Laufzeit oder ein Präfix.',
      pl: 'Pozostaw domyślne, chyba że przepisy prawne lub specyficzna architektura domen wymaga zmiany czasu ważności plików cookie lub ich przedrostków.',
    },
  },
  {
    id: 'ogt_dtc',
    rec: 'default',
    title: { en: 'Manage data transmission', de: 'Datenübertragung verwalten', pl: 'Zarządzanie przesyłaniem danych' },
    recText: { en: 'Default', de: 'Standard', pl: 'Domyślnie' },
    why: {
      en: 'Controls how advertising signals are sent before the user has given consent.',
      de: 'Steuert, wie Werbesignale übertragen werden, bevor die Einwilligung des Nutzers vorliegt.',
      pl: 'Kontroluje przesyłanie sygnałów reklamowych przed uzyskaniem zgody użytkownika.',
    },
  },
  {
    id: 'ogt_consent_defaults',
    rec: 'disable',
    title: { en: 'Override consent mode defaults', de: 'Standardeinstellungen für den Einwilligungsmodus überschreiben', pl: 'Nadpisywanie trybu zgody' },
    recText: { en: 'Off / default', de: 'Aus / Standard', pl: 'Wyłącz / domyślnie' },
    why: {
      en: 'Consent should be managed by the cookie banner (CMP) and the native Consent Mode settings in GTM – not by manual overrides in this panel.',
      de: 'Einwilligungen sollten über das Cookie-Banner (CMP) und die nativen Consent-Mode-Einstellungen in GTM verwaltet werden – nicht durch manuelles Überschreiben hier.',
      pl: 'Zarządzanie zgodami powinno odbywać się bezpośrednio przez baner cookie (CMP) i natywne ustawienia Consent Mode w GTM, a nie ręczne nadpisywanie w tym panelu.',
    },
  },
  {
    id: 'ogt_dma',
    rec: 'configure',
    title: {
      en: 'Manage default settings for data collection consent',
      de: 'Standardeinstellungen für die Einwilligung zur Datenerhebung verwalten',
      pl: 'Ustawienia domyślne zgód',
    },
    recText: { en: 'Configure via the CMP', de: 'Über das CMP konfigurieren', pl: 'Konfiguruj przez CMP' },
    why: {
      en: 'Defines the default consent states (e.g. ad_storage, analytics_storage). Must match the actual state of the consent banner (GDPR) on the site.',
      de: 'Legt die Standard-Einwilligungszustände fest (z. B. ad_storage, analytics_storage). Muss zum tatsächlichen Zustand des Consent-Banners (DSGVO) auf der Seite passen.',
      pl: 'Służy do określania domyślnych stanów zgód (np. ad_storage, analytics_storage). Powinno być zintegrowane ze stanem faktycznym banera zgód RODO na stronie.',
    },
  },
];

export const GUIDE_BY_ID = new Map(SETTINGS_GUIDE.map((g) => [g.id, g]));

/** Section 2 of the document: should Google tags be combined? */
export const COMBINE_GUIDE: Record<Lang, { title: string; intro: string; dont: { title: string; items: string[] }; do: { title: string; items: string[] }; summary: string }> = {
  en: {
    title: 'Combine Google tags?',
    intro: 'Google can combine tags so one tag ID sends data to several products (e.g. several GA4 properties or Google Ads).',
    dont: {
      title: 'Do NOT combine (recommended in most cases)',
      items: [
        'Different companies, brands or separate projects: separate GA4 properties per site/brand would get mixed data and events.',
        'Complex GTM setups: it is much easier and safer to control data flow in the GTM container – separate GA4 Event tags per Measurement ID give full control over where each event goes.',
      ],
    },
    do: {
      title: 'Combining makes sense when',
      items: [
        'Migrating from an old hard-coded tag without access to the site code (e.g. an old Google Ads tag) and you want to attach a new GA4 property to it.',
        'Multi-channel marketing on the same property: you want to send exactly the same signals and events to Google Ads and GA4 from one main trigger.',
      ],
    },
    summary: 'In professional setups rely on GTM to route traffic and events instead of combining Google tags in the Google panel – it keeps things transparent and prevents data leaking between properties.',
  },
  de: {
    title: 'Google-Tags kombinieren?',
    intro: 'Google kann Tags kombinieren, sodass eine Tag-ID Daten an mehrere Dienste sendet (z. B. mehrere GA4-Properties oder Google Ads).',
    dont: {
      title: 'NICHT kombinieren (in den meisten Fällen empfohlen)',
      items: [
        'Verschiedene Firmen, Marken oder getrennte Projekte: getrennte GA4-Properties pro Seite/Marke würden Daten und Ereignisse vermischen.',
        'Komplexe GTM-Setups: Datenflüsse lassen sich im GTM-Container einfacher und sicherer steuern – eigene GA4-Event-Tags pro Mess-ID geben volle Kontrolle, wohin jedes Ereignis geht.',
      ],
    },
    do: {
      title: 'Kombinieren lohnt sich, wenn',
      items: [
        'Migration von einem alten, fest eingebauten Tag ohne Zugriff auf den Seitencode (z. B. altes Google-Ads-Tag) und eine neue GA4-Property angehängt werden soll.',
        'Multi-Channel-Marketing auf derselben Property: exakt dieselben Signale und Ereignisse sollen gleichzeitig an Google Ads und GA4 gehen.',
      ],
    },
    summary: 'In professionellen Setups das Routing von Traffic und Ereignissen in GTM steuern, statt Google-Tags im Google-Panel zu kombinieren – das sorgt für Transparenz und verhindert Datenlecks zwischen Properties.',
  },
  pl: {
    title: 'Czy łączyć Google tagi?',
    intro: 'Google pozwala łączyć tagi (Combine Google Tags), aby jeden identyfikator tagu wysyłał dane do wielu usług (np. kilku usług GA4 lub Google Ads).',
    dont: {
      title: 'Kiedy NIE łączyć (rekomendowane w większości przypadków)',
      items: [
        'Różne firmy, marki lub odrębne projekty: osobne usługi GA4 dla różnych stron/marek – łączenie spowoduje wymieszanie danych i zdarzeń.',
        'Złożone wdrożenia GTM: łatwiej i bezpieczniej kontrolować przesyłanie danych z poziomu kontenera – osobne tagi GA4 Event dla każdego Measurement ID dają pełną kontrolę, dokąd trafia każde zdarzenie.',
      ],
    },
    do: {
      title: 'Kiedy WARTO połączyć',
      items: [
        'Migracja ze starego tagu bez dostępu do kodu strony: na stronie zaszyty jest stary tag (np. Google Ads), a chcesz podpiąć pod niego nową usługę GA4.',
        'Multi-channel marketing na tej samej usłudze: te same sygnały i zdarzenia mają trafiać jednocześnie do Google Ads i GA4 z jednego wyzwolenia.',
      ],
    },
    summary: 'W profesjonalnych konfiguracjach opieraj się na GTM do rozdzielania ruchu i zdarzeń, zamiast łączyć Google tagi w panelu Google. Zapewnia to przejrzystość i zapobiega wyciekom danych między usługami.',
  },
};

import { withBase } from "@/lib/basePath";
import ConditionsView from "./ConditionsView";
import { LOCALES, translate, type Locale } from "@/lib/i18n";

// Static export needs every locale route enumerated at build time.
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export const dynamicParams = false;

export default async function Page({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  return (
    <main className="page">
      <header className="masthead">
        <h1>{translate(locale, "site.title")}</h1>
        <p className="muted">{translate(locale, "site.tagline")}</p>
        <nav className="locales">
          {LOCALES.map((code) => (
            <a
              key={code}
              href={withBase(`/${code}/`)}
              aria-current={code === locale ? "page" : undefined}
            >
              {code.toUpperCase()}
            </a>
          ))}
        </nav>
      </header>

      <ConditionsView locale={locale} />

    </main>
  );
}

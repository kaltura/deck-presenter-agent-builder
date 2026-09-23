// Shared by client/app.js (bundled into the browser) and content.mjs (Node).
// No Node-only APIs here, so both can import it as-is.
//
// Splits a markdown file on top-level "# Heading" lines into {heading: body} pairs.
// Every multi-value prompt file (tool descriptions, nav-nudge templates, route
// answers) uses this same convention so there is exactly one parser to maintain.
export function parseSections(md) {
  const sections = {};
  const headerRe = /^# (.+)$/gm;
  const matches = [...md.matchAll(headerRe)];
  for (let i = 0; i < matches.length; i += 1) {
    const key = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : md.length;
    sections[key] = md.slice(start, end).trim();
  }
  return sections;
}

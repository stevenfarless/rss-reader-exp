/* Small dependency-free Markdown renderer for plain-text RSS articles.
   Raw HTML is escaped. DOMPurify sanitizes the resulting HTML before use. */
(function (root) {
  "use strict";
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);
  }
  function urlOK(value, image) {
    const u = String(value || "").replace(/\\([\\*{}\[\]()#+.!_>~-])/g, "$1").trim();
    if (/^(https?:|#)/i.test(u)) return u;
    if (!image && /^(mailto:|tel:)/i.test(u)) return u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && u.slice(0, 2) !== "//") return u;
    return "";
  }
  function inline(s) {
    s = String(s).replace(/\]\s*\\\(/g, "](");
    const held = [];
    const hold = html => {
      const key = "\u0000" + held.length + "\u0000";
      held.push(html);
      return key;
    };
    s = s.replace(/(\x60+)([\s\S]*?)\1/g, (_, ticks, code) => hold("<code>" + esc(code.replace(/\n/g, " ")) + "</code>"));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (_, alt, href, title) => {
      const u = urlOK(href, true);
      return u ? hold('<img src="' + esc(u) + '" alt="' + esc(alt) + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">") : esc(alt);
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/g, (_, label, href, title) => {
      const u = urlOK(href, false);
      return u ? hold('<a href="' + esc(u) + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + inline(label) + "</a>") : label;
    });
    s = esc(s);
    s = s.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<]+[^\s<.,:;"')\]])/g, '$1<a href="$2">$2</a>');
    s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, "<strong>$1$2</strong>");
    s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*|(^|[^_])_([^_\n]+)_/g, (_, a, b, c, d) => (a || c || "") + "<em>" + (b || d || "") + "</em>");
    s = s.replace(/  \n/g, "<br>\n");
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)]);
  }
  function blockStart(lines, i) {
    const s = lines[i] || "";
    return /^\s*(?:\x60{3,}|~{3,}|#{1,6}\s|>|(?:[-*_]\s*){3,}$)/.test(s) ||
      /^\s*(?:[-+*]|\d+[.)])\s+/.test(s) ||
      (i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]));
  }
  function blocks(lines, context) {
    context = context || { slugs: Object.create(null) };
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*(\x60{3,}|~{3,})\s*([^\s]*)?.*$/.exec(line);
      if (fence) {
        const marker = fence[1][0], size = fence[1].length, code = [];
        i++;
        const close = new RegExp("^\\s*" + (marker === "\x60" ? "\x60" : "~") + "{" + size + ",}\\s*$");
        while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        const lang = (fence[2] || "").replace(/[^a-zA-Z0-9_-]/g, "");
        out.push("<pre><code" + (lang ? ' class="language-' + lang + '"' : "") + ">" + esc(code.join("\n")) + "</code></pre>");
        continue;
      }
      const h = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        const n = h[1].length;
        const base = h[2].replace(/<[^>]*>/g, "").toLowerCase().replace(/&amp;/g, "&").replace(/ & /g, "--").replace(/&/g, "-").replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-") || "section";
        const count = context.slugs[base] || 0; context.slugs[base] = count + 1;
        const slug = base + (count ? "-" + count : "");
        out.push('<h' + n + ' id="' + slug + '">' + inline(h[2]) + "</h" + n + ">"); i++; continue;
      }
      if (i + 1 < lines.length && /^\s*(?:=+|-+)\s*$/.test(lines[i + 1]) && line.trim()) {
        const n = lines[i + 1].trim()[0] === "=" ? 1 : 2;
        out.push("<h" + n + ">" + inline(line.trim()) + "</h" + n + ">"); i += 2; continue;
      }
      if (/^\s*(?:(?:[-*_]\s*){3,})$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ""));
        out.push("<blockquote>" + blocks(quote, context) + "</blockquote>"); continue;
      }
      if (i + 1 < lines.length && /^\s*\|?.*\|.*$/.test(line) &&
          /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const cells = row => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(x => x.trim());
        const head = cells(line), align = cells(lines[i + 1]).map(x => x.startsWith(":") && x.endsWith(":") ? "center" : x.endsWith(":") ? "right" : x.startsWith(":") ? "left" : "");
        let html = "<table><thead><tr>";
        head.forEach((x, n) => html += "<th" + (align[n] ? ' style="text-align:' + align[n] + '"' : "") + ">" + inline(x) + "</th>");
        html += "</tr></thead><tbody>"; i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          const cellsInRow = cells(lines[i++]); html += "<tr>";
          head.forEach((_, n) => html += "<td" + (align[n] ? ' style="text-align:' + align[n] + '"' : "") + ">" + inline(cellsInRow[n] || "") + "</td>");
          html += "</tr>";
        }
        out.push(html + "</tbody></table>"); continue;
      }
      const first = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
      if (first) {
        const indent = first[1].length, ordered = /^\d/.test(first[2]), tag = ordered ? "ol" : "ul", items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m || m[1].length !== indent || /^\d/.test(m[2]) !== ordered) break;
          const part = [m[3]]; i++;
          while (i < lines.length) {
            const next = lines[i], nested = /^(\s*)([-+*]|\d+[.)])\s+/.exec(next);
            if (nested && nested[1].length <= indent) break;
            if (!next.trim()) {
              if (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) { part.push(""); i++; continue; }
              break;
            }
            if (/^\s+/.test(next)) { part.push(next.slice(Math.min(next.length, indent + 2))); i++; continue; }
            break;
          }
          items.push("<li>" + blocks(part, context).replace(/^<p>([\s\S]*?)<\/p>/, "$1") + "</li>");
        }
        out.push("<" + tag + ">" + items.join("") + "</" + tag + ">"); continue;
      }
      const para = [line.trim()]; i++;
      while (i < lines.length && lines[i].trim() && !blockStart(lines, i)) para.push(lines[i++].trim());
      out.push("<p>" + inline(para.join("\n")) + "</p>");
    }
    return out.join("\n");
  }
  function looksLikeMarkdown(value) {
    const s = String(value || "").replace(/\r\n?/g, "\n");
    return /^\s*(?:#{1,6}\s|>{1,}\s?|[-+*]\s+|\d+[.)]\s+|\x60{3,}|~{3,})/m.test(s) ||
      /^\s*\|?.*\|.*\n\s*\|?\s*:?-{3,}/m.test(s) ||
      /\[[^\]]+\]\([^)]+\)/.test(s) || /(?:\*\*|__|~~)[^\n]+?(?:\*\*|__|~~)/.test(s);
  }
  const api = {
    render: value => blocks(String(value || "").replace(/\r\n?/g, "\n").split("\n")),
    looksLikeMarkdown: looksLikeMarkdown
  };
  root.RSSMarkdown = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

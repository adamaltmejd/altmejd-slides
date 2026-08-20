-- filter.lua
-- Reads `slide-remote:` keys from document YAML and emits <meta> tags the
-- browser-side plugin reads at init time. Theme-agnostic; emits nothing if
-- the consumer didn't set the keys.
--
-- Recognized keys (all under top-level `slide-remote:`):
--   worker-url:        string  (required to activate; absent = silent)
--   show-button:       bool    default false
--   disable-on-params: list    extra URL params that mean "do not activate"

function Pandoc(doc)
  if not quarto.doc.isFormat("revealjs") then return doc end

  local cfg = doc.meta["slide-remote"]
  if not cfg then return doc end

  local function s(v) return v and pandoc.utils.stringify(v) or "" end

  local worker_url = s(cfg["worker-url"])
  local show_button = s(cfg["show-button"]) == "true"

  local disable_params = {}
  if cfg["disable-on-params"] then
    for _, p in ipairs(cfg["disable-on-params"]) do
      table.insert(disable_params, s(p))
    end
  end

  local meta_tags = {
    string.format('<meta name="slide-remote-worker-url" content="%s">', worker_url),
    string.format('<meta name="slide-remote-show-button" content="%s">', tostring(show_button)),
    string.format('<meta name="slide-remote-disable-on-params" content="%s">',
      table.concat(disable_params, ",")),
  }

  quarto.doc.include_text("in-header", table.concat(meta_tags, "\n"))
  return doc
end

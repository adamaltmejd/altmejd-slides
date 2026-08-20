-- Document behavior and YAML configuration for Altmejd Slides.
--
-- Quarto remains responsible for slide construction and Reveal initialization.
-- This filter only translates the extension's namespaced metadata into CSS
-- variables, generates section agendas, and registers the handout runtime.

local stringify = pandoc.utils.stringify

local agenda = {
  enabled = true,
  bullets = "bullet",
  heading = "Outline",
  clickable = false,
  sections = pandoc.List(),
}

local color_variables = {
  { "background", "--altmejd-background" },
  { "foreground", "--altmejd-foreground" },
  { "primary", "--altmejd-primary" },
  { "secondary", "--altmejd-secondary" },
  { "accent", "--altmejd-accent" },
  { "info", "--altmejd-info" },
  { "success", "--altmejd-success" },
  { "surface", "--altmejd-surface" },
  { "border", "--altmejd-border" },
  { "muted", "--altmejd-muted" },
  { "code-background", "--altmejd-code-background" },
  { "output-background", "--altmejd-output-background" },
  { "heading-line-start", "--altmejd-heading-line-start" },
  { "heading-line-end", "--altmejd-heading-line-end" },
  { "agenda-background", "--altmejd-agenda-background" },
  { "agenda-foreground", "--altmejd-agenda-foreground" },
}

local css_color_functions = {
  rgb = true,
  rgba = true,
  hsl = true,
  hsla = true,
  hwb = true,
  lab = true,
  lch = true,
  oklab = true,
  oklch = true,
  color = true,
}

local function as_boolean(value, fallback)
  if value == nil then
    return fallback
  end
  if value == true then
    return true
  end
  if value == false then
    return false
  end
  local text = stringify(value):lower()
  if text == "true" or text == "yes" or text == "1" then
    return true
  elseif text == "false" or text == "no" or text == "0" then
    return false
  end
  return fallback
end

local function is_css_color(value)
  local hex = value:match("^#([%da-fA-F]+)$")
  if hex ~= nil then
    return #hex == 3 or #hex == 4 or #hex == 6 or #hex == 8
  end

  if value:match("^[%a][%a%-]*$") then
    return true
  end

  local name, arguments = value:match("^([%a]+)%((.*)%)$")
  return name ~= nil
    and css_color_functions[name:lower()] == true
    and arguments ~= ""
    and not arguments:find("[;{}<>]")
end

local function include_color_overrides(colors)
  if colors == nil then
    return
  end
  if type(colors) ~= "table" then
    quarto.log.warning("altmejd-slides.colors must be a map; ignoring it")
    return
  end

  local declarations = {}
  for _, mapping in ipairs(color_variables) do
    local key, variable = mapping[1], mapping[2]
    if colors[key] ~= nil then
      local value = stringify(colors[key])
      if is_css_color(value) then
        table.insert(declarations, string.format("  %s: %s;", variable, value))
      else
        quarto.log.warning(
          string.format("altmejd-slides.colors.%s is not a valid CSS color; ignoring it", key)
        )
      end
    end
  end

  if #declarations > 0 then
    quarto.doc.include_text(
      "in-header",
      table.concat({
        '<style id="altmejd-slides-config">',
        ":root {",
        table.concat(declarations, "\n"),
        "}",
        "</style>",
      }, "\n")
    )
  end
end

local function read_agenda(options)
  agenda.enabled = true
  agenda.bullets = "bullet"
  agenda.heading = "Outline"
  agenda.clickable = false

  if options == nil or options == true then
    return
  elseif options == false then
    agenda.enabled = false
    return
  elseif type(options) ~= "table" then
    quarto.log.warning("altmejd-slides.agenda must be a map or boolean; using defaults")
    return
  end

  agenda.enabled = as_boolean(options.enabled, true)

  if options.bullets ~= nil then
    local bullets = stringify(options.bullets)
    if bullets == "bullet" or bullets == "numbered" or bullets == "none" then
      agenda.bullets = bullets
    else
      quarto.log.warning(
        "altmejd-slides.agenda.bullets must be 'bullet', 'numbered', or 'none'; using 'bullet'"
      )
    end
  end

  if options.heading == false then
    agenda.heading = nil
  elseif options.heading ~= nil then
    agenda.heading = options.heading
  end

  agenda.clickable = as_boolean(options.clickable, false)
end

local function read_metadata(meta)
  quarto.doc.add_html_dependency({
    name = "altmejd-slides-handout",
    version = "0.1.0",
    scripts = { "resources/handout.js" },
  })

  agenda.sections = pandoc.List()
  local options = meta["altmejd-slides"]
  if options == nil or type(options) ~= "table" then
    read_agenda(nil)
    return meta
  end

  include_color_overrides(options.colors)
  read_agenda(options.agenda)
  return meta
end

local function is_agenda_section(header)
  return header.level == 1
    and not header.classes:includes("no-agenda")
end

local function collect_sections(header)
  if agenda.enabled and is_agenda_section(header) then
    agenda.sections:insert({
      content = header.content,
      identifier = header.identifier or "",
    })
  end
end

local function agenda_item(section, active)
  local classes = active and { "agenda-active" } or { "agenda-inactive" }
  local content = section.content

  if agenda.clickable and section.identifier ~= "" then
    content = {
      pandoc.Link(section.content, "#" .. section.identifier),
    }
  end

  return {
    pandoc.Div(
      { pandoc.Plain(content) },
      pandoc.Attr("", classes)
    ),
  }
end

local function make_agenda_list(items)
  if agenda.bullets == "numbered" then
    return { pandoc.OrderedList(items) }
  elseif agenda.bullets == "none" then
    local blocks = pandoc.List()
    for _, item in ipairs(items) do
      blocks:extend(item)
    end
    return blocks
  end
  return { pandoc.BulletList(items) }
end

local function build_agendas(blocks)
  if not agenda.enabled then
    return blocks
  end

  local output = pandoc.List()
  local current = 0

  for _, block in ipairs(blocks) do
    if block.t == "Header" and is_agenda_section(block) then
      current = current + 1
      if not block.classes:includes("agenda-slide") then
        block.classes:insert("agenda-slide")
      end
      output:insert(block)

      if agenda.heading ~= nil then
        output:insert(pandoc.Div(
          { pandoc.Para(agenda.heading) },
          pandoc.Attr("", { "agenda-heading" })
        ))
      end

      local items = pandoc.List()
      for index, section in ipairs(agenda.sections) do
        items:insert(agenda_item(section, index == current))
      end
      output:insert(pandoc.Div(
        make_agenda_list(items),
        pandoc.Attr("", { "agenda" })
      ))
    else
      output:insert(block)
    end
  end

  return output
end

if quarto.doc.is_format("revealjs") then
  return {
    { Meta = read_metadata },
    { Header = collect_sections },
    { Blocks = build_agendas },
  }
end

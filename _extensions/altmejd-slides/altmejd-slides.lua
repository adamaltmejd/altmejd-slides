-- Document behavior and YAML configuration for Altmejd Slides.
--
-- Quarto remains responsible for slide construction and Reveal initialization.
-- This filter only translates the extension's namespaced metadata into CSS
-- variables, generates section agendas, enriches common research layouts, and
-- registers the presentation/handout runtime.

local stringify = pandoc.utils.stringify

local agenda = {
  enabled = true,
  bullets = "none",
  heading = nil,
  clickable = false,
  sections = pandoc.List(),
}

local bundled_math = true

local auto_stretch = true

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

-- The CSS named colors, so keyword typos warn instead of silently producing
-- an invalid custom-property value downstream.
local css_named_colors = {}
for name in ([[
aliceblue antiquewhite aqua aquamarine azure beige bisque black
blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
slateblue slategray slategrey snow springgreen steelblue tan teal thistle
tomato transparent turquoise violet wheat white whitesmoke yellow
yellowgreen
]]):gmatch("%S+") do
  css_named_colors[name] = true
end

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
    return css_named_colors[value:lower()] == true
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
  agenda.bullets = "none"
  agenda.heading = nil
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
        "altmejd-slides.agenda.bullets must be 'bullet', 'numbered', or 'none'; using 'none'"
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
  agenda.sections = pandoc.List()
  local options = meta["altmejd-slides"]
  bundled_math = true
  auto_stretch = as_boolean(meta["auto-stretch"], true)
  if options == nil or type(options) ~= "table" then
    read_agenda(nil)
  else
    include_color_overrides(options.colors)
    read_agenda(options.agenda)
    bundled_math = as_boolean(options.math, true)
  end

  quarto.doc.add_html_dependency({
    name = "altmejd-slides-runtime",
    version = "0.5.0",
    scripts = { "resources/runtime.js" },
  })
  -- Bundled OFL typefaces, vendored like KaTeX so rendering and PDF capture
  -- never depend on host-installed fonts.
  quarto.doc.add_html_dependency({
    name = "altmejd-slides-fonts",
    version = "0.5.0",
    stylesheets = { "resources/fonts/fonts.css" },
  })
  if bundled_math then
    quarto.doc.add_html_dependency({
      name = "altmejd-slides-katex",
      version = "0.18.4",
      scripts = { "resources/katex/katex.min.js" },
      stylesheets = { "resources/katex/katex.min.css" },
    })
    quarto.doc.add_html_dependency({
      name = "altmejd-slides-math",
      version = "0.5.0",
      scripts = { "resources/math.js" },
    })
  end
  return meta
end

local function escape_html(text)
  return text
    :gsub("&", "&amp;")
    :gsub("<", "&lt;")
    :gsub(">", "&gt;")
end

local function render_math(math)
  if not bundled_math then
    return nil
  end
  local display = math.mathtype == "DisplayMath"
  local classes = display and "math display altmejd-math" or "math inline altmejd-math"
  return pandoc.RawInline(
    "html",
    string.format('<span class="%s">%s</span>', classes, escape_html(math.text))
  )
end

-- `[alt text](url){.qr}` renders as a generated QR code image. The encoder is
-- the vendored speedata luaqrcode (BSD-3), so decks stay offline and
-- deterministic; the link text becomes the image's alt text.
local qrencode = nil

local function load_qrencode()
  if qrencode == nil then
    local source = debug.getinfo(1, "S").source:sub(2)
    qrencode = dofile(pandoc.path.join({ pandoc.path.directory(source), "qrencode.lua" }))
  end
  return qrencode
end

local function qr_svg(matrix)
  local size = #matrix
  -- The QR specification requires a four-module quiet zone, so it ships
  -- inside the SVG rather than depending on CSS padding ratios.
  local quiet = 4
  local total = size + 2 * quiet
  local parts = pandoc.List()
  parts:insert(string.format(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d">',
    total,
    total
  ))
  parts:insert(string.format('<rect width="%d" height="%d" fill="#fff"/>', total, total))
  parts:insert('<path fill="#000" d="')
  for y = 1, size do
    local x = 1
    while x <= size do
      if matrix[x][y] > 0 then
        local run = x
        while run <= size and matrix[run][y] > 0 do
          run = run + 1
        end
        parts:insert(string.format(
          "M%d %dh%dv1h-%dz",
          x - 1 + quiet,
          y - 1 + quiet,
          run - x,
          run - x
        ))
        x = run
      else
        x = x + 1
      end
    end
  end
  parts:insert('"/></svg>')
  return table.concat(parts)
end

local function render_qr_link(link)
  if not link.classes:includes("qr") then
    return nil
  end
  local ok, matrix_or_message = pcall(function()
    local success, result = load_qrencode().qrcode(link.target, 2)
    if not success then
      error(result, 0)
    end
    return result
  end)
  if not ok then
    quarto.log.warning(string.format(
      "could not encode a QR code for %s: %s",
      link.target,
      tostring(matrix_or_message)
    ))
    return nil
  end

  local alt = stringify(pandoc.Plain(link.content))
  if alt == "" then
    alt = "QR code linking to " .. link.target
  end
  return pandoc.RawInline(
    "html",
    string.format(
      '<img class="qr nostretch" alt="%s" src="data:image/svg+xml;base64,%s" />',
      escape_html(alt):gsub('"', "&quot;"),
      quarto.base64.encode(qr_svg(matrix_or_message))
    )
  )
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

local function contains_image(block)
  local found = false
  pandoc.walk_block(block, {
    Image = function(image)
      found = true
      return image
    end,
  })
  return found
end

local function panel_children(div)
  local panels = pandoc.List()
  for _, block in ipairs(div.content) do
    if block.t == "Div"
      and (block.classes:includes("column") or block.classes:includes("figure-panel"))
    then
      panels:insert(block)
    end
  end
  return panels
end

local function is_figure_panels(div)
  if div.t ~= "Div" then
    return false
  end

  local explicit = div.classes:includes("figure-panels")
  if not explicit and not div.classes:includes("columns") then
    return false
  end

  local panels = panel_children(div)
  if explicit then
    if #panels < 1 or #panels > 2 then
      return false
    end
  elseif #panels ~= 2 then
    return false
  end

  for _, panel in ipairs(panels) do
    if not contains_image(panel) then
      return false
    end
  end
  return true
end

local function contains_internal_link(block)
  local found = false
  pandoc.walk_block(block, {
    Link = function(link)
      if link.target:match("^#") then
        found = true
      end
      return link
    end,
  })
  return found
end

local function contains_media(inlines)
  local found = false
  pandoc.walk_inline(pandoc.Span(inlines), {
    Image = function(image)
      found = true
      return image
    end,
  })
  return found
end

-- Navigation is a row of short internal links. A link wrapping a figure is a
-- clickable figure, not a control, and docking it as navigation collapses it.
local function is_navigation_inline(inline)
  if inline.t == "Link" then
    return inline.target:match("^#") ~= nil and not contains_media(inline.content)
  elseif inline.t == "Space" or inline.t == "SoftBreak" or inline.t == "LineBreak" then
    return true
  elseif inline.t == "Str" then
    return inline.text:match("^[·|/]+$") ~= nil
  elseif inline.t == "Span" then
    return (inline.classes:includes("back")
        or inline.classes:includes("primary"))
      and contains_internal_link(pandoc.Plain(inline.content))
      and not contains_media(inline.content)
  end
  return false
end

local function is_navigation_paragraph(block)
  if block.t ~= "Para" or not contains_internal_link(block) then
    return false
  end
  for _, inline in ipairs(block.content) do
    if not is_navigation_inline(inline) then
      return false
    end
  end
  return true
end

local function label_back_controls(block)
  return pandoc.walk_block(block, {
    Link = function(link)
      if link.classes:includes("back") and link.attributes["aria-label"] == nil then
        link.attributes["aria-label"] = "Back to " .. stringify(pandoc.Plain(link.content))
      end
      return link
    end,
  })
end

-- Quarto's auto-stretch skips any slide that carries an `::: {.aside}`, so a
-- lone figure on such a slide keeps its intrinsic size and left alignment
-- instead of filling the slide. Re-apply the class Quarto would have added;
-- the runtime then reserves the aside's height for it like any other stretch.
local function count_images(blocks)
  local count = 0
  for _, block in ipairs(blocks) do
    pandoc.walk_block(block, {
      Image = function(image)
        count = count + 1
        return image
      end,
    })
  end
  return count
end

local function is_lone_image_block(block)
  if block.t ~= "Para" and block.t ~= "Plain" then
    return false
  end
  return #block.content == 1 and block.content[1].t == "Image"
end

-- A captioned or linked figure cannot take the stretch class: Quarto hoists
-- the image out of its `<figure>` or `<a>` wrapper only on its own
-- auto-stretch path, and a stretch class left nested inside one of those
-- wrappers overflows the slide instead of filling it. Those fill by layout.
local function is_wrapped_figure(block)
  if block.t == "Figure" then
    return #block.content == 1 and is_lone_image_block(block.content[1])
  end
  if block.t ~= "Para" and block.t ~= "Plain" then
    return false
  end
  local inline = #block.content == 1 and block.content[1] or nil
  return inline ~= nil
    and inline.t == "Link"
    and #inline.content == 1
    and inline.content[1].t == "Image"
end

local function has_direct_aside(blocks)
  for _, block in ipairs(blocks) do
    if block.t == "Div"
      and block.classes:includes("aside")
      and not block.classes:includes("notes")
    then
      return true
    end
  end
  return false
end

local function stretch_lone_figure(header, blocks)
  if not has_direct_aside(blocks) or count_images(blocks) ~= 1 then
    return blocks
  end

  for index, block in ipairs(blocks) do
    if is_lone_image_block(block) then
      blocks[index] = pandoc.walk_block(block, {
        Image = function(image)
          if not (image.classes:includes("r-stretch") or image.classes:includes("stretch")) then
            image.classes:insert("r-stretch")
          end
          return image
        end,
      })
      return blocks
    elseif is_wrapped_figure(block) then
      if not header.classes:includes("layout-fill") then
        header.classes:insert("layout-fill")
      end
      return blocks
    end
  end

  return blocks
end

local function stretch_aside_figures(blocks)
  local output = pandoc.List()
  local index = 1

  while index <= #blocks do
    local block = blocks[index]
    output:insert(block)
    index = index + 1

    if block.t == "Header" and block.level == 2 then
      local slide = pandoc.List()
      while index <= #blocks
        and not (blocks[index].t == "Header" and blocks[index].level <= 2)
      do
        slide:insert(blocks[index])
        index = index + 1
      end
      output:extend(stretch_lone_figure(block, slide))
    end
  end

  return output
end

-- A `.table-note` div is a sibling of the table it annotates, so CSS alone
-- cannot size the note to the table's rendered width. Pair the two in a
-- shared fit-content wrapper; the note then spans exactly the table.
local function wraps_table(block)
  if block.t == "Table" then
    return true
  end
  if block.t == "Div" or block.t == "Figure" then
    for _, child in ipairs(block.content) do
      if wraps_table(child) then
        return true
      end
    end
  end
  return false
end

local function enrich_research_layouts(blocks)
  local output = pandoc.List()
  local current_slide = nil

  for _, block in ipairs(blocks) do
    block = label_back_controls(block)
    if block.t == "Header" and block.level <= 2 then
      current_slide = block.level == 2 and block or nil
    elseif block.t == "Div"
      and block.classes:includes("table-note")
      and #output > 0
      and wraps_table(output[#output])
    then
      block = pandoc.Div(
        { output:remove(#output), block },
        pandoc.Attr("", { "table-with-note" })
      )
    elseif current_slide ~= nil and is_figure_panels(block) then
      if not block.classes:includes("figure-panels") then
        block.classes:insert("figure-panels")
      end
      if not current_slide.classes:includes("layout-fill") then
        current_slide.classes:insert("layout-fill")
      end
    elseif current_slide ~= nil and is_navigation_paragraph(block) then
      block = pandoc.Div({ block }, pandoc.Attr("", { "slide-nav" }))
    end
    output:insert(block)
  end

  if auto_stretch then
    output = stretch_aside_figures(output)
  end

  return output
end

local function build_agendas(blocks)
  local output = pandoc.List()
  local current = 0
  local index = 1

  while index <= #blocks do
    local block = blocks[index]
    if agenda.enabled and block.t == "Header" and is_agenda_section(block) then
      current = current + 1
      if not block.classes:includes("agenda-slide") then
        block.classes:insert("agenda-slide")
      end
      output:insert(block)
      index = index + 1

      local kicker = pandoc.List()
      while index <= #blocks and blocks[index].t ~= "Header" do
        kicker:insert(blocks[index])
        index = index + 1
      end

      if agenda.heading ~= nil then
        output:insert(pandoc.Div(
          { pandoc.Para(agenda.heading) },
          pandoc.Attr("", { "agenda-heading" })
        ))
      end

      if #kicker > 0 then
        if #kicker == 1
          and kicker[1].t == "Div"
          and kicker[1].classes:includes("section-kicker")
        then
          output:insert(kicker[1])
        else
          output:insert(pandoc.Div(
            kicker,
            pandoc.Attr("", { "section-kicker" })
          ))
        end
      end

      local items = pandoc.List()
      for index, section in ipairs(agenda.sections) do
        items:insert(agenda_item(section, index == current))
      end
      output:insert(pandoc.Div(
        make_agenda_list(items),
        pandoc.Attr("", { "agenda", "agenda-bullets-" .. agenda.bullets })
      ))
    else
      output:insert(block)
      index = index + 1
    end
  end

  return enrich_research_layouts(output)
end

if quarto.doc.is_format("revealjs") then
  return {
    { Meta = read_metadata },
    { Math = render_math, Link = render_qr_link },
    { Header = collect_sections },
    { Blocks = build_agendas },
  }
end

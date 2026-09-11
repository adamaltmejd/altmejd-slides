# Deck workflow wrappers. `quarto add` copies only the extension directory, so
# this Makefile ships with the starter template to give each deck the same
# entry points. Publishing is always explicit: rendering and previewing never
# touch Cloudflare.

PUBLISH_SCRIPT := $(firstword \
	$(wildcard _extensions/*/altmejd-slides/tools/publish-cloudflare.ts) \
	$(wildcard _extensions/altmejd-slides/tools/publish-cloudflare.ts))

PDF_SCRIPT := $(firstword \
	$(wildcard _extensions/*/altmejd-slides/tools/pdf/render_revealjs_pdfs.py) \
	$(wildcard _extensions/altmejd-slides/tools/pdf/render_revealjs_pdfs.py))
PYTHON ?= python3
PDF_SITE_DIR ?= .
PDF_ARGS ?=

# Extra flags, e.g. make publish PUBLISH_ARGS="--slug ucls26" or the same for
# make unpublish when a state file records several talks.
PUBLISH_ARGS ?=
# Quarto needs an explicit input outside a project. Do not guess between talks.
DECK_INPUT ?= $(if $(wildcard _quarto.yml _quarto.yaml),.,$(if $(filter 1,$(words $(wildcard *.qmd))),$(wildcard *.qmd)))

.PHONY: render preview pdf-setup pdf publish unpublish bootstrap-gateway

render:
	@test -n "$(DECK_INPUT)" || { \
		echo "Set DECK_INPUT=talk.qmd when the directory has no project or sole QMD."; exit 1; }
	quarto render "$(DECK_INPUT)"

preview:
	@test -n "$(DECK_INPUT)" || { \
		echo "Set DECK_INPUT=talk.qmd when the directory has no project or sole QMD."; exit 1; }
	quarto preview "$(DECK_INPUT)"

# The explicit setup may download locked packages; capture itself stays offline.
pdf-setup:
	@test -n "$(PDF_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	bun install --frozen-lockfile --ignore-scripts --cwd "$(dir $(PDF_SCRIPT))"

pdf: render
	@test -n "$(PDF_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	$(PYTHON) "$(PDF_SCRIPT)" --site-dir "$(PDF_SITE_DIR)" $(PDF_ARGS)

publish:
	@test -n "$(PUBLISH_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	quarto run "$(PUBLISH_SCRIPT)" $(PUBLISH_ARGS)

unpublish:
	@test -n "$(PUBLISH_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	quarto run "$(PUBLISH_SCRIPT)" --unpublish $(PUBLISH_ARGS)

bootstrap-gateway:
	@echo "bootstrap-gateway is retired. Deploy the shared gateway centrally from the altmejd-slides repository; see docs/publishing.md." >&2
	@exit 1

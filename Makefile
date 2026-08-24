# Deck workflow wrappers. `quarto add` copies only the extension directory, so
# this Makefile ships with the starter template to give each deck the same
# entry points. Publishing is always explicit: rendering and previewing never
# touch Cloudflare.

PUBLISH_SCRIPT := $(firstword \
	$(wildcard _extensions/*/altmejd-slides/tools/publish-cloudflare.ts) \
	$(wildcard _extensions/altmejd-slides/tools/publish-cloudflare.ts))

# Extra flags for the publisher, e.g. make publish PUBLISH_ARGS="--slug ucls26"
PUBLISH_ARGS ?=

.PHONY: render preview publish bootstrap-gateway

render:
	quarto render

preview:
	quarto preview

publish:
	@test -n "$(PUBLISH_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	quarto run "$(PUBLISH_SCRIPT)" $(PUBLISH_ARGS)

bootstrap-gateway:
	@test -n "$(PUBLISH_SCRIPT)" || { \
		echo "altmejd-slides extension not found under _extensions/"; exit 1; }
	quarto run "$(PUBLISH_SCRIPT)" --bootstrap-gateway $(PUBLISH_ARGS)

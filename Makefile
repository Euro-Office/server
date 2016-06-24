OUTPUT_DIR = build
OUTPUT = $(OUTPUT_DIR)

GRUNT = grunt
GRUNT_FLAGS = --no-color -v 

GRUNT_FILES = Gruntfile.js.out

FILE_CONVERTER = $(OUTPUT)/FileConverter/bin
FILE_CONVERTER_FILES += ../core/build/lib/linux_64/*.so
FILE_CONVERTER_FILES += ../core/build/bin/icu/linux_64/*.so*
FILE_CONVERTER_FILES += ../core/build/bin/linux/x2t
FILE_CONVERTER_FILES += ../core/build/bin/linux/icudtl_dat.S

HTML_FILE_INTERNAL := $(FILE_CONVERTER)/HtmlFileInternal
HTML_FILE_INTERNAL_FILES += ../core/build/lib/linux_64/HtmlFileInternal
HTML_FILE_INTERNAL_FILES += ../core/build/cef/linux_64/**

SPELLCHECKER_DICTIONARIES := $(OUTPUT)/SpellChecker/dictionaries
SPELLCHECKER_DICTIONARY_FILES += ../dictionaries/**

SCHEMA_DIR = schema
SCHEMA_FILES = $(SCHEMA_DIR)/**
SCHEMA = $(OUTPUT)/$(SCHEMA_DIR)/

TOOLS_DIR = tools
TOOLS_FILES = ../core/build/bin/AllFontsGen/linux_64
TOOLS = $(OUTPUT)/$(TOOLS_DIR)/

LICENSE_FILES = LICENSE.txt 3rd-Party.txt license/
LICENSE = $(addsuffix $(OUTPUT)/, LICENSE_FILES)

all: $(FILE_CONVERTER) $(SPELLCHECKER_DICTIONARIES) $(TOOLS) $(SCHEMA) $(LICENSE)
		
$(FILE_CONVERTER): $(GRUNT_FILES)
	mkdir -p $(FILE_CONVERTER) $(HTML_FILE_INTERNAL) && \
		cp -r -t $(FILE_CONVERTER) $(FILE_CONVERTER_FILES) && \
		cp -r -t $(HTML_FILE_INTERNAL) $(HTML_FILE_INTERNAL_FILES) && \
		sed 's,../../..,/var/www/onlyoffice/documentserver,' -i $(FILE_CONVERTER)/DoctRenderer.config

$(SPELLCHECKER_DICTIONARIES): $(GRUNT_FILES)
	mkdir -p $(SPELLCHECKER_DICTIONARIES) && \
		cp -r -t $(SPELLCHECKER_DICTIONARIES) $(SPELLCHECKER_DICTIONARY_FILES)

$(SCHEMA):
	mkdir -p $(SCHEMA) && \
		cp -r -t $(SCHEMA) $(SCHEMA_FILES)
		
$(TOOLS):
	mkdir -p $(TOOLS) && \
		cp -r -t $(TOOLS) $(TOOLS_FILES) && \
		mv $(TOOLS)/linux_64 $(TOOLS)/AllFontsGen
		
$(LICENSE):
	mkdir -p $(OUTPUT) && \
		cp -r -t $(OUTPUT) $(LICENSE_FILES)
		
$(GRUNT_FILES):
	cd $(@D) && \
		npm install && \
		$(GRUNT) $(GRUNT_FLAGS)
	echo "Done" > $@
	
clean:
	rm -rf $(OUTPUT) $(GRUNT_FILES)
	

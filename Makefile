OUTPUT_DIR = build
OUTPUT = $(OUTPUT_DIR)

GRUNT = grunt
GRUNT_FLAGS = --no-color -v 

GRUNT_FILES = Gruntfile.js.out

FILE_CONVERTER = $(OUTPUT)/FileConverter/bin
FILE_CONVERTER_FILES += ../core/build/lib/linux_64/*.so
FILE_CONVERTER_FILES += /usr/local/lib/libicudata.so.55*
FILE_CONVERTER_FILES += /usr/local/lib/libicuuc.so.55*
FILE_CONVERTER_FILES += ../core/build/bin/linux/x2t
FILE_CONVERTER_FILES += ../v8/third_party/icu/linux/icudtl_dat.S

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

LICENSE_JS := $(OUTPUT)/Common/sources/license.js

.PHONY: all clean install uninstall

all: $(FILE_CONVERTER) $(SPELLCHECKER_DICTIONARIES) $(TOOLS) $(SCHEMA) $(LICENSE)

build-date: $(GRUNT_FILES)
	sed "s|const buildVersion = .*|const buildVersion = '${PRODUCT_VERSION}';|" -i $(LICENSE_JS)
	sed "s|const buildNumber = .*|const buildNumber = ${BUILD_NUMBER};|" -i $(LICENSE_JS)
	sed "s|const buildDate = .*|const buildDate = '$$(date +%F)';|" -i $(LICENSE_JS)
	
htmlfileinternal: $(FILE_CONVERTER)
	mkdir -p $(HTML_FILE_INTERNAL) && \
		cp -r -t $(HTML_FILE_INTERNAL) $(HTML_FILE_INTERNAL_FILES) && \
		
$(FILE_CONVERTER): $(GRUNT_FILES)
	mkdir -p $(FILE_CONVERTER) && \
		cp -r -t $(FILE_CONVERTER) $(FILE_CONVERTER_FILES) && \
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

install:
	sudo adduser --quiet --home /var/www/onlyoffice --system --group onlyoffice

	sudo mkdir -p /var/log/onlyoffice
	sudo mkdir -p /var/lib/onlyoffice/documentserver/App_Data

	sudo chown onlyoffice:onlyoffice -R /var/www/onlyoffice
	sudo chown onlyoffice:onlyoffice -R /var/log/onlyoffice
	sudo chown onlyoffice:onlyoffice -R /var/lib/onlyoffice

	sudo cp -r build/. /var/www/onlyoffice/documentserver/
	
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libDjVuFile.so /lib/libDjVuFile.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libdoctrenderer.so /lib/libdoctrenderer.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libHtmlFile.so /lib/libHtmlFile.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libHtmlRenderer.so /lib/libHtmlRenderer.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libPdfReader.so /lib/libPdfReader.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libPdfWriter.so /lib/libPdfWriter.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libXpsFile.so /lib/libXpsFile.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libUnicodeConverter.so /lib/libUnicodeConverter.so
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libicudata.so.55 /lib/libicudata.so.55
	sudo ln -s /var/www/onlyoffice/documentserver/server/FileConverter/Bin/libicuuc.so.55 /lib/libicuuc.so.55

	sudo -u onlyoffice "/var/www/onlyoffice/documentserver/server/tools/AllFontsGen"\
		"/usr/share/fonts"\
		"/var/www/onlyoffice/documentserver/sdkjs/common/AllFonts.js"\
		"/var/www/onlyoffice/documentserver/sdkjs/common/Images"\
		"/var/www/onlyoffice/documentserver/server/FileConverter/bin/font_selection.bin"
uninstall:
	sudo userdel onlyoffice
	
	sudo unlink /lib/libDjVuFile.so
	sudo unlink /lib/libdoctrenderer.so
	sudo unlink /lib/libHtmlFile.so
	sudo unlink /lib/libHtmlRenderer.so
	sudo unlink /lib/libPdfReader.so
	sudo unlink /lib/libPdfWriter.so
	sudo unlink /lib/libXpsFile.so
	sudo unlink /lib/libUnicodeConverter.so
	sudo unlink /lib/libicudata.so.55
	sudo unlink /lib/libicuuc.so.55

	sudo rm -rf /var/www/onlyoffice/documentserver
	sudo rm -rf /var/log/onlyoffice/documentserver
	sudo rm -rf /var/lib/onlyoffice/documentserver	

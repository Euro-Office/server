#include <errno.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    FILE *f = fopen("/etc/euro-office/documentserver/local.json", "r");
    if (f) {
        printf("READABLE\n");
        fclose(f);
    } else {
        printf("BLOCKED: %s\n", strerror(errno));
    }
    return 0;
}

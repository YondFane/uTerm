#include "UTermTestSupport.h"
#include <sys/file.h>

// Keep the real libc lock available when Swift resolves Darwin.flock as the C struct.
// Swift 将 Darwin.flock 解析为 C 结构时，通过此入口调用实际 libc 文件锁。
int32_t uterm_test_flock(int32_t descriptor, int32_t operation) {
    return flock(descriptor, operation);
}

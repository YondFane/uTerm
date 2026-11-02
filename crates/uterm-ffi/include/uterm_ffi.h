#ifndef UTERM_FFI_H
#define UTERM_FFI_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define UTERM_ABI_VERSION 1
typedef struct { const uint8_t *data; size_t length; uint64_t allocation; } UTermBuffer;
typedef void (*UTermCallback)(void *context, uint64_t operation, const uint8_t *data, size_t length);

/* Inputs and callback bytes are borrowed only for the call. Returned buffers require release by allocation ID.
 * 输入和回调字节仅在调用期间借用；返回缓冲区必须按 allocation ID 释放。 */
UTermBuffer uterm_open(const uint8_t *root, size_t length, uint64_t *handle);
UTermBuffer uterm_call(uint64_t handle, const uint8_t *request, size_t length);
void uterm_buffer_release(uint64_t allocation);
uint32_t uterm_request(uint64_t handle, uint64_t operation, const uint8_t *request, size_t length, UTermCallback callback, void *context);
/* Cancellation suppresses delivery and skips work not yet started; it does not undo committed mutations.
 * 取消抑制结果回调并跳过尚未开始的工作；已提交的写入不会撤销。 */
uint32_t uterm_cancel(uint64_t handle, uint64_t operation);
/* A NULL callback unsubscribes and waits for an active event callback to finish.
 * NULL 回调用于退订，并等待正在执行的事件回调完成。 */
uint32_t uterm_subscribe(uint64_t handle, UTermCallback callback, void *context);
/* Async callbacks run on a Rust worker; synchronous call events run on the caller. Close drains both.
 * Do not call synchronous operations, subscribe or close from callbacks; enqueue them after return.
 * 异步回调运行在 Rust 工作线程；同步调用事件运行在调用线程。close 等待两者结束。
 * 不得在回调中同步调用、订阅或关闭；应排队至回调返回后执行。 */
uint32_t uterm_close(uint64_t handle);
uint32_t uterm_abi_version(void);

#ifdef __cplusplus
}
#endif
#endif

---
title: Indirect Draw
slug: indirect-draw
---

## 소개

일반 드로우는 **count/offset 같은 드로우 파라미터를 CPU가 커맨드 버퍼에 기록**한다. 간접 드로우(indirect draw)는 그 파라미터를 **GPU 메모리의 버퍼**에서 읽는다. CPU는 파라미터를 채운 버퍼만 준비하고, GPU가 실행 시점에 버퍼에서 값을 읽어 드로우한다.

> **용어 정리**
> - **Indirect Command**: 드로우 파라미터를 담은 구조체. indexed용과 non-indexed용 레이아웃이 **다르다**.
> - **Indirect Buffer**: indirect command들이 연속으로 담긴 `VkBuffer`. usage에 `VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT`.
> - **drawCount**: 한 번의 `vkCmdDraw*Indirect`가 실행할 indirect command 개수. `> 1`이면 멀티 드로우.
> - **per-draw 데이터**: 드로우마다 다른 셰이더 입력(색·변환 등)을 담는 버퍼. 보통 SSBO.

간접 드로우의 핵심 가치는 **CPU 개입 없이 드로우 파라미터를 GPU가 결정**할 수 있다는 점이다. GPU 컬링(오클루전 쿼리·컴퓨트로 파라미터 수정)과 결합하면 CPU가 수만 개 드로우를 일일이 기록하지 않아도 된다.

---

## 1. 두 종류의 indirect command 구조체

간접 드로우 구조체는 indexed / non-indexed로 **레이아웃이 다르다**. 같은 버퍼에 섞어 담을 수 없으므로, 둘 다 쓴다면 **버퍼를 분리**하는 게 깔끔하다.

### 1.1. indexed — `VkDrawIndexedIndirectCommand`

```c
typedef struct VkDrawIndexedIndirectCommand {
    uint32_t    indexCount;      // 인덱스 개수
    uint32_t    instanceCount;   // 인스턴스 개수 (보통 1)
    uint32_t    firstIndex;      // index buffer 안의 첫 인덱스 오프셋
    int32_t     vertexOffset;    // 인덱스에 더해지는 정점 오프셋 (signed!)
    uint32_t    firstInstance;   // gl_InstanceIndex의 시작 값 (1.2+)
} VkDrawIndexedIndirectCommand;  // 20 bytes
```

### 1.2. non-indexed — `VkDrawIndirectCommand`

```c
typedef struct VkDrawIndirectCommand {
    uint32_t    vertexCount;     // 정점 개수
    uint32_t    instanceCount;   // 인스턴스 개수 (보통 1)
    uint32_t    firstVertex;     // 첫 정점 오프셋
    uint32_t    firstInstance;   // gl_InstanceIndex의 시작 값 (1.2+)
} VkDrawIndirectCommand;         // 16 bytes
```

> **주의 — `vertexOffset`은 signed**
> indexed 구조체의 `vertexOffset`만 `int32_t`다. 나머지 필드는 전부 `uint32_t`. 구조체를 직접 `float`/`int`로 잘못 쓰면 음수 오프셋이 깨진다.

### 1.3. 오프셋·stride 정렬

- `offset`과 `stride`는 **4바이트 배수**여야 한다 (VUID `vkCmdDraw*Indirect`의 offset/stride 제약).
- indexed와 non-indexed 구조체 크기가 다르므로 stride도 각각 `sizeof(VkDrawIndexedIndirectCommand)` / `sizeof(VkDrawIndirectCommand)`로 따로 넘긴다.
- **버퍼를 나눠야 하는 이유가 여기 있다** — 한 버퍼에 두 종류를 섞으면 stride가 맞지 않아 다음 엔트리 오프셋이 어긋난다.

---

## 2. feature 분기 — multiDrawIndirect와 maxDrawIndirectCount

`drawCount > 1`로 한 번에 여러 드로우를 쏘려면 `multiDrawIndirect` feature가 켜져 있어야 한다.

```c
VkPhysicalDeviceFeatures physFeatures;
vkGetPhysicalDeviceFeatures(physicalDevice, &physFeatures);

bool supportsMultiDrawIndirect = (physFeatures.multiDrawIndirect == VK_TRUE);
```

> **`multiDrawIndirect`는 하드 요구가 아니다**
> 기능을 안 켜고 조회만 해서 분기하는 패턴이 실전에서 유용하다. 지원하면 배치로, 아니면 단일 루프로 폴백.

### 2.1. `maxDrawIndirectCount` limit

`multiDrawIndirect`가 켜져 있어도 **`VkPhysicalDeviceLimits.maxDrawIndirectCount`** 만큼만 drawCount를 넘길 수 있다. 일부 모바일 GPU(Mali pre-G710 등)는 이 값이 **1**이다 — 멀티 드로우 자체를 못 쓴다.

```c
VkPhysicalDeviceProperties props;
vkGetPhysicalDeviceProperties(physicalDevice, &props);
// props.limits.maxDrawIndirectCount
```

### 2.2. 배치 vs 단일 폴백

```
supportsMultiDrawIndirect && maxDrawIndirectCount > 1
  ├── true  → drawCount = N (배치, push constant 1회)
  └── false → drawCount = 1 루프 (드로우마다 push)
```

배치일 때는 같은 파이프라인의 연속 드로우를 **하나의 indirect 커맨드**로 묶어 `vkCmdDrawIndexedIndirect(cmd, buf, offset, N, stride)` 한 번에 쏜다.

---

## 3. firstInstance와 drawIndirectFirstInstance (1.1 제약)

indirect 구조체의 `firstInstance`를 0이 아닌 값으로 쓰려면 **`drawIndirectFirstInstance`** feature(Vulkan 1.2 코어)가 필요하다. **Vulkan 1.1에서는 `firstInstance`가 항상 0**이어야 한다.

- Vulkan 1.1 최소 타깃이라면 `firstInstance`에 **인스턴스/드로우 인덱스를 넣지 말 것**.
- 대신 드로우 인덱스를 셰이더에 전달하는 다른 통로가 필요하다.

### 3.1. 드로우 인덱스를 셰이더로 — push constant + gl_DrawID

대표적인 대체 통로 두 가지:

| 통로 | 방법 | 조건 |
|------|------|------|
| **push constant** | `drawBase`(배치 시작 인덱스)를 `vkCmdPushConstants`로 배치당 1회 push | Vulkan 1.0+ |
| **gl_DrawID / SV_DrawIndex** | non-indexed indirect 드로우에서 현재 draw 인덱스를 셰이더가 직접 읽음 | `shaderDrawParameters` feature (Vulkan 1.1 코어) |

실전 조합: **push constant `drawBase` + 셰이더의 드로우 인덱스**를 더해 per-draw 슬롯을 계산한다.

```glsl
// 슬롯 = 배치 시작 인덱스 + 이번 드로우의 순번
uint slot = drawBase + gl_DrawID;   // GLSL
// HLSL/DXIL: SV_DrawIndex
```

- `gl_DrawID`는 **non-indexed** 간접 드로우에서만 유효하다 (indexed는 지원하지 않음 — `shaderDrawParameters`의 명시적 제한).
- 배치(`drawCount=N`)일 땐 `drawBase`를 배치 시작 슬롯으로 한 번만 push, 단일 폴백일 땐 드로우마다 push.

### 3.2. 최소 타깃 Vulkan 1.1

`appInfo.apiVersion = VK_API_VERSION_1_1`로 최소 타깃을 고정하면 `shaderDrawParameters`(1.1 코어)는 확보되고, `drawIndirectFirstInstance`(1.2)는 쓰지 못한다는 전제가 명확해진다. 이 경계를 코드에 일관되게 유지하는 게 중요하다.

---

## 4. 버퍼 생성 — device-local + staging 업로드

indirect buffer는 GPU가 실행 시점에 읽으므로 **device-local**이 정석이다. CPU가 직접 쓸 수 없으니 staging(host-visible)에 쓰고 `vkCmdCopyBuffer`로 올린다.

```c
VkBufferCreateInfo ci{};
ci.sType       = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
ci.size        = capacity * sizeof(VkDrawIndexedIndirectCommand);
ci.usage       = VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT   // 간접 드로우 소스
               | VK_BUFFER_USAGE_TRANSFER_DST_BIT;     // staging에서 복사받음
ci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
```

- 메모리 타입은 **`DEVICE_LOCAL`** 우선.
- `TRANSFER_DST_BIT`를 빼먹으면 `vkCmdCopyBuffer`가 VUID 위반.
- GPU 컬링으로 indirect buffer를 컴퓨트에서 수정하려면 `STORAGE_BUFFER_BIT`도 추가.

### 4.1. staging → device-local 복사

```c
// staging(host-visible)에 CPU가 memcpy → Flush 후:
VkBufferCopy region{};
region.srcOffset = 0;
region.dstOffset = 0;
region.size      = count * sizeof(VkDrawIndexedIndirectCommand);
vkCmdCopyBuffer(cmd, stagingBuffer, indirectBuffer, 1, &region);
```

CPU가 쓴 host-visible 메모리는 `HOST_COHERENT`가 아니면 `vkFlushMappedMemoryRanges`로 flush해야 GPU가 본다.

---

## 5. 배리어 — TRANSFER → DRAW_INDIRECT

복사 직후에는 indirect buffer가 아직 **transfer 쓰기** 상태다. 드로우가 읽기 전에 **`DRAW_INDIRECT` 접근**으로 전환하는 배리어가 필요하다.

```c
VkBufferMemoryBarrier barrier{};
barrier.sType         = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER;
barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;   // copy가 씀
barrier.dstAccessMask = VK_ACCESS_INDIRECT_COMMAND_READ_BIT; // 드로우가 읽음
barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.buffer   = indirectBuffer;
barrier.offset   = 0;
barrier.size     = VK_WHOLE_SIZE;

vkCmdPipelineBarrier(
    cmd,
    VK_PIPELINE_STAGE_TRANSFER_BIT,      // src stage
    VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT, // dst stage — 컴퓨트 컬링이면 COMPUTE_SHADER
    0, 0, nullptr, 1, &barrier, 0, nullptr
);
```

> **핵심** — src access는 **쓰기**(`TRANSFER_WRITE`), dst access는 **읽기**(`INDIRECT_COMMAND_READ`)다. src/dst를 둘 다 읽기로 걸면 드로우가 복사 결과를 못 본다.

---

## 6. 배칭 전략 — 파이프라인별 그룹 + push constant

간접 드로우를 제대로 쓰려면 드로우 리스트를 **파이프라인별로 묶어** 배칭해야 한다. 같은 파이프라인의 드로우만 하나의 `vkCmdDraw*Indirect`로 모을 수 있다.

```
drawCommands (frame)
  ├─ pipelineIndex로 그룹
  ├─ 그룹별: push constant drawBase + vkCmdDraw*Indirect(drawCount=N)
  └─ 파이프라인 전환 횟수 최소화
```

- **per-draw 슬롯**은 indirect command 순서와 SSBO(per-draw 배열) 인덱스를 1:1로 맞춘다.
- 배치가 가능하면 push는 **배치당 1회**로 줄어든다 (드로우마다 push하는 것과 대비).

```c
if (supportsMultiDrawIndirect) {
    vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(uint32_t), &baseSlot);
    vkCmdDrawIndexedIndirect(cmd, indirectBuf, baseIdx * argSize, N, argSize);
} else {
    for (uint32_t k = 0; k < N; ++k) {
        uint32_t slot = baseSlot + k;
        vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(uint32_t), &slot);
        vkCmdDrawIndexedIndirect(cmd, indirectBuf, (baseIdx + k) * argSize, 1, argSize);
    }
}
```

---

## 7. per-draw 데이터 — SSBO + 드로우 인덱스

드로우마다 다른 색·변환을 넘기려면 **per-draw 배열 SSBO**를 두고, 셰이더가 슬롯으로 인덱싱한다. 슬롯은 위에서 본 `drawBase + gl_DrawID`다.

```glsl
// per-draw SSBO (storage buffer, binding 0)
struct PerDraw {
    mat4 model;
    vec4 color;
    // ...
};
layout(set = 3, binding = 0) buffer PerDrawBuffer {
    PerDraw perDraw[];   // 슬롯 = drawBase + gl_DrawID
} perDrawData;
```

- per-draw 배열 크기는 드로우 수에 맞춰 **grow-on-demand** (부족하면 더 큰 버퍼 재할당 + descriptor 재갱신).
- descriptor는 버퍼 핸들이 바뀌면 다시 `vkUpdateDescriptorSets`해야 한다.
- per-draw SSBO도 host-visible(`HOST_VISIBLE | HOST_COHERENT` 우선)로 CPU가 직접 채운다.

---

## 8. 자주 빠지는 주의사항 모음

- [ ] indexed / non-indexed 구조체를 **한 버퍼에 섞음** → stride 불일치로 다음 엔트리 오프셋 깨짐.
- [ ] `VK_BUFFER_USAGE_TRANSFER_DST_BIT` 없이 staging 복사 → VUID.
- [ ] 복사 후 **배리어 누락** (또는 src/dst access를 읽기로 잘못) → 드로우가 복사 결과를 못 봄.
- [ ] `multiDrawIndirect` 조회 없이 `drawCount > 1` → 미지원 장치에서 오류.
- [ ] `maxDrawIndirectCount` 무시 → 값이 1인 장치(Mali pre-G710)에서 멀티 드로우 실패.
- [ ] Vulkan 1.1에서 `firstInstance != 0` → `drawIndirectFirstInstance` 미지원.
- [ ] `gl_DrawID`/`SV_DrawIndex`를 **indexed** 간접 드로우에서 사용 → 미지원.
- [ ] indirect 버퍼 offset·stride가 4바이트 배수 아님.
- [ ] per-draw SSBO grow 시 **descriptor 재갱신 누락** → 이전(작은) 버퍼를 계속 참조.
- [ ] host-visible staging을 `HOST_COHERENT` 없이 쓰고 flush 누락 → GPU가 쓴 데이터를 못 봄.

---

## 9. 빠른 참조

| 의도 | 권장 |
|------|------|
| indirect 버퍼 메모리 | `DEVICE_LOCAL` + staging(`vkCmdCopyBuffer`) 업로드 |
| 복사 후 동기화 | `TRANSFER_WRITE → INDIRECT_COMMAND_READ` (src=TRANSFER, dst=DRAW_INDIRECT) |
| 멀티 드로우 | `multiDrawIndirect` + `maxDrawIndirectCount` 조회 후 분기 |
| per-draw 슬롯 | push constant `drawBase` + `gl_DrawID`(non-indexed) |
| 1.1 타깃 firstInstance | 항상 0, 슬롯은 push constant로 |
| GPU 컬링 | indirect buffer에 `STORAGE_BUFFER_BIT` 추가, 컴퓨트에서 수정 |
| 드로우 리스트 | 파이프라인별 그룹 → 배치로 push 1회 |

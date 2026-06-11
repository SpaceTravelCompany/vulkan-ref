---
title: Push Constants
slug: push-constants
---

## 소개

Push constant는 **셰이더가 디스크립터나 버퍼 없이 빠르게 읽는 작은 상수**다. `vkCmdPushConstants` 한 번 호출로 GPU 내부 레지스터에 값이 박혀 셰이더의 `layout(push_constant) uniform ...`로 즉시 읽힌다.

> **용어 정리**
> - **Push Constant Range**: 파이프라인 레이아웃이 정의한 stageFlags + offset + size 묶음.
> - **Fast Path**: 메모리 백드 갱신보다 빠른 상수 전달 경로. 디스크립터/UBO보다 빠르고 작은 데이터에 최적.
> - **maxPushConstantsSize**: 디바이스가 보장하는 push constant 전체 크기 한계 (보통 128~256 바이트).
> - **Incremental Update**: `vkCmdPushConstants`가 일부 바이트만 갱신 가능. 다른 영역은 이전 값 유지.

이 문서는 push constant의 **선언 → 사용 → 갱신** 흐름과 주의사항을 다룬다.

---

---

## 1. 큰 그림

```cmdstack
파이프라인 레이아웃:
  VkPipelineLayoutCreateInfo
    pushConstantRangeCount: 1
    pPushConstantRanges:   [{offset=0, size=32, stageFlags=VS|FS}]
---
셰이더 (GLSL):
  layout(push_constant) uniform PC {
      mat4 mvp;
      vec4 color;
  } pc;
  gl_Position = pc.mvp * pos;  // 즉시 읽힘, 디스크립터 불필요
---
매 드로우/디스패치:
  vkCmdBindPipeline(...)
  vkCmdPushConstants(cmd, layout, VS|FS, 0, 32, &data)
  vkCmdDraw(...)
```

**핵심 포인트:**

- **메모리 백드 없음**. 디스크립터/UBO/SSBO 없이 셰이더에 직접 주입.
- **수 KB를 넘어가면 안 됨**. 한계 초과 시 디바이스가 못 만듦.
- **Incremental update** 가능 — 한 range의 일부 바이트만 갱신해도 나머지는 유지.

---

---

## 2. 파이프라인 레이아웃에 range 선언

```c
VkPushConstantRange pcRange{};
pcRange.offset   = 0;
pcRange.size     = 32;                              // 4 바이트 정렬
pcRange.stageFlags = VK_SHADER_STAGE_VERTEX_BIT
                   | VK_SHADER_STAGE_FRAGMENT_BIT;

VkPipelineLayoutCreateInfo plci{};
plci.setLayoutCount         = 0;                    // 디스크립터 없이도 OK
plci.pSetLayouts            = nullptr;
plci.pushConstantRangeCount = 1;
plci.pPushConstantRanges    = &pcRange;

VkPipelineLayout layout;
vkCreatePipelineLayout(device, &plci, nullptr, &layout);
```

> **스펙 원문** "Push constants represent a high speed path to modify constant data in pipelines that is expected to outperform memory-backed resource updates."
>> 디스크립터/UBO/SSBO보다 빠른 경로. 작은 상수(매트릭스, 색, 시간, 인스턴스 ID)에 최적.

### 2.1. size 한계

`VkPhysicalDeviceLimits::maxPushConstantsSize` (보통 **128 ~ 256 바이트**). 모든 range의 size 합계가 이 값을 넘으면 안 됨. 멀티 range로 분리 가능 (각 range가 겹치지 않게).

> **스펙 원문 (VUID-vkCmdPushConstants-size-00371)** `size` must be less than or equal to `VkPhysicalDeviceLimits::maxPushConstantsSize` minus `offset`.
>> 단일 range의 size도 한계 이내여야 함.

---

---

## 3. 셰이더에서 받기 (SPIR-V / GLSL)

```glsl
// GLSL: layout(push_constant) 블록
layout(push_constant) uniform PerDraw {
    mat4 mvp;          // 64 바이트
    vec4 tint;         // 16 바이트
    uint instanceId;   // 4 바이트
    uint flags;        // 4 바이트
    // 총 88 바이트 — 4의 배수
} pc;

void main() {
    gl_Position = pc.mvp * vec4(inPosition, 1.0);
    fragColor = pc.tint;
}
```

**규칙:**

- 블록의 총 크기는 **4의 배수** (SPIR-V uniform block 정렬)
- `offset`, `size` 모두 **4의 배수**여야 함 (VUID-vkCmdPushConstants-offset-00368, size-00369)
- 16바이트 정렬 멤버(`mat4`, `vec4`)는 자체 정렬 OK

---

---

## 4. `vkCmdPushConstants` — 값 갱신

```c
void vkCmdPushConstants(
    VkCommandBuffer      commandBuffer,
    VkPipelineLayout     layout,
    VkShaderStageFlags   stageFlags,
    uint32_t             offset,
    uint32_t             size,
    const void*          pValues);
```

**전형적 호출:**

```c
struct PerDrawPC { mat4 mvp; vec4 tint; uint instanceId; uint flags; } pc;
// ... pc 채우기 ...
vkCmdPushConstants(cmd, layout,
    VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
    0, sizeof(pc), &pc);
vkCmdDraw(cmd, vertexCount, 1, 0, 0);
```

### 4.1. Incremental update (부분 갱신)

```c
// mvp만 갱신, tint/instanceId/flags는 이전 값 유지
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT,
    0, sizeof(mat4), &newMvp);
// ... 다른 draw ...
// tint만 갱신
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_FRAGMENT_BIT,
    64, sizeof(vec4), &newTint);  // 64 = mvp 직후 오프셋
```

> **스펙 원문 (VUID-vkCmdPushConstants-offset-01795)** For each byte in the range specified by `offset` and `size` and for each shader stage in `stageFlags`, there must be a push constant range in layout that includes that byte and that stage.
>> 갱신 영역이 **레이아웃에 선언된 range를 완전히 포함**해야 함. 일부만 덮으면 안 됨.

> **스펙 원문 (VUID-vkCmdPushConstants-offset-01796)** For each byte ... and for each push constant range that overlaps that byte, `stageFlags` must include all stages in that push constant range's `VkPushConstantRange::stageFlags`.
>> stageFlags는 겹치는 **모든 range의 stageFlags를 포함**해야 함. 한 range가 VS+FS로 선언됐는데 `stageFlags=VS`만 주면 무효.

> **스펙 원문** "When a command buffer begins recording, all push constant values are undefined. Reads of undefined push constant values by the executing shader return undefined values."
>> 커맨드 버퍼 시작 시 push constant는 **모두 undefined**. **파이프라인 바인딩 전**에 반드시 `vkCmdPushConstants`로 초기화해야 함.

### 4.2. `vkCmdPushConstants2` / `VkPushConstantsInfo` (1.4 / `VK_KHR_maintenance6`)

Vulkan 1.4에 추가된 변형. 파라미터를 `VkPushConstantsInfo` 구조체로 받는다.

```c
// 1.4+
VkPushConstantsInfo info{};
info.sType      = VK_STRUCTURE_TYPE_PUSH_CONSTANTS_INFO;
info.layout     = layout;
info.stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;
info.offset     = 0;
info.size       = sizeof(pc);
info.pValues    = &pc;
vkCmdPushConstants2(cmd, &info);
```

**`vkCmdPushConstants`와 차이:**

- **기능은 동일**. 결과, 제약, 알 수 있는 VUID 모두 같음.
- **왜 존재하나**: 구조체 기반이라 미래에 새 필드가 추가되어도 함수 시그니처를 깨지 않고 pNext에 확장 가능. 1.4 표준화 + `VK_KHR_maintenance6` 시점부터 권장.
- **추가 옵션**: `dynamicPipelineLayout` feature가 켜져 있으면 `layout = VK_NULL_HANDLE`로 두고 pNext에 `VkPipelineLayoutCreateInfo`를 체이닝해 **레이아웃 자체를 동적 생성** 가능.
- **선택 기준**:
  - 1.3 이하 디바이스만 타깃 → `vkCmdPushConstants`
  - 1.4+ 또는 `VK_KHR_maintenance6` 지원 타깃 → `vkCmdPushConstants2` 권장

---

---

## 5. 동적 디스크립터 오프셋 vs Push Constant

둘 다 "디스패치/draw 마다 바뀌는 작은 값"을 위한 메커니즘이지만, **성능/유연성이 다름**.

| 특성 | Push Constant | Dynamic UBO Offset | Dynamic SSBO Offset |
|------|---------------|--------------------|--------------------|
| 최대 크기 | 128~256 B (한계) | 64KB (UBO당), 풀은 `maxUniformBufferRange` × `maxDescriptorSet` | 훨씬 큼 |
| 메모리 백드 | 없음 (GPU 레지스터) | UBO 필요 | SSBO 필요 |
| 업데이트 명령 | `vkCmdPushConstants` (단순 memcpy) | `vkCmdBindDescriptorSets` + dynamic offset | 동일 |
| 인스턴스/드로우 단위 갱신 | 매우 빠름 (의도된 fast path) | 약간 더 느림 (디스크립터 갱신) | 비슷 |
| 여러 draw 공유 | 같은 layout 안에서는 명시적 재push 필요 | 같은 set 재바인딩 | 동일 |
| 셰이더 입력 | `layout(push_constant) uniform` | `layout(set=X, binding=Y) uniform UBO` | 동일 |

**선택 가이드:**

- **수 바이트 ~ 64 바이트 단일 상수** (MVP 행렬, 색, 인스턴스 ID, 머티리얼 ID) → push constant
- **수십 ~ 수백 바이트 가변 데이터** (per-instance 배열, 가변 인덱스 테이블) → dynamic UBO offset
- **셰이더가 큰 데이터셋을 인덱싱** → SSBO + dynamic offset
- **여러 draw 사이 공유 가능한 작은 상수** → 인라인 유니폼 블록 (`VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK`)

---

---

## 6. 전형적 패턴

### 6.1. Per-draw MVP

```c
// 파이프라인 레이아웃 (한 번)
VkPushConstantRange pc{};
pc.size       = sizeof(glm::mat4);
pc.stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
vkCreatePipelineLayout(device, plciWithPc, nullptr, &layout);

// 매 draw
vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(glm::mat4), &mvp);
vkCmdDraw(cmd, vc, 1, 0, 0);
```

### 6.2. 멀티 range — VS/FS 분리

```c
VkPushConstantRange ranges[2] = {
    {0,  sizeof(mat4), VK_SHADER_STAGE_VERTEX_BIT},                              // MVP (VS only)
    {64, sizeof(vec4),  VK_SHADER_STAGE_FRAGMENT_BIT},                            // tint (FS only)
};
// 총 80 바이트 사용
```

VS는 0~63, FS는 64~79 영역만 보게 됨. 셰이더 측에서도 동일하게 두 블록으로 나눠 받음.

### 6.3. Per-instance 데이터 — indirect draw와 함께

```c
// InstanceID를 push constant로 (인스턴스마다 다른 값)
// 또는: VK_KHR_shader_object + draw mesh task에서 push constant
vkCmdPushConstants(cmd, layout, VS, 0, sizeof(uint32_t), &instanceBaseId);
vkCmdDraw(cmd, vcPerInstance, instanceCount, 0, instanceBaseId);
```

### 6.4. 시간/프레임 정보

```c
struct FramePC {
    float time;            // 0
    float deltaTime;       // 4
    uint32_t frameNumber;  // 8
    uint32_t flags;        // 12
    // 16 바이트
};
vkCmdPushConstants(cmd, layout, ALL_STAGES, 0, sizeof(FramePC), &framePC);
```

### 6.5. Compute dispatch — workgroup별 시작 오프셋

```c
// GLSL
layout(push_constant) uniform PC {
    uint baseInstance;
    uint workGroupShift;
    float time;
} pc;

// C
vkCmdPushConstants(cmd, layout,
    VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t) * 2 + sizeof(float),
    &(struct { uint base; uint shift; float t; }){ instanceBase, wgShift, time });
vkCmdDispatch(cmd, wgCountX, 1, 1);
```

**장점**: dispatch마다 다른 partition을 처리해야 하는 파티클/GPU culling 등 compute 파이프라인에서 매번 UBO를 새로 만들 필요 없이 push로 전달.

---

---

## 7. `VkPushConstantBankInfoNV` (NV push constant bank, 선택)

`VK_NV_push_constant_bank` 확장은 **하나의 range를 여러 bank로 분할**해 부분 갱신. `VkPushConstantsInfo::pNext`에 체이닝.

```c
VkPushConstantBankInfoNV bank{};
bank.sType = VK_STRUCTURE_TYPE_PUSH_CONSTANT_BANK_INFO_NV;
bank.bank = 0;  // 어느 bank
info.pNext = &bank;
```

대부분의 경우 불필요. 표준 push constant로 충분.

---

---

## 8. 자주 빠지는 주의사항 모음

### 8.1. 크기/정렬

- [ ] `offset`이 4의 배수가 아님 (VUID-vkCmdPushConstants-offset-00368).
- [ ] `size`가 4의 배수가 아님 (VUID-vkCmdPushConstants-size-00369).
- [ ] `offset >= maxPushConstantsSize` (VUID-vkCmdPushConstants-offset-00370).
- [ ] `offset + size > maxPushConstantsSize` (VUID-vkCmdPushConstants-size-00371).
- [ ] `size == 0` (VUID-vkCmdPushConstants-size-arraylength).

### 8.2. range / stage 매칭

- [ ] `vkCmdPushConstants`의 stageFlags가 겹치는 range의 stageFlags를 **모두 포함**하지 않음 (VUID-offset-01796).
- [ ] 갱신 영역(`offset`+`size`)이 **레이아웃의 어떤 range에도** 완전히 포함되지 않음 (VUID-offset-01795).
- [ ] 같은 오프셋이 두 range에 걸쳐 있고 stageFlags가 다른데 한쪽 stageFlags만 지정.
- [ ] range의 size가 셰이더의 `push_constant` 블록 크기보다 작음 → 셰이더가 일부 못 읽음.

### 8.3. 초기화 / 파이프라인 바인딩

- [ ] **파이프라인 바인딩 전** push constant 갱신 누락 → 셰이더가 undefined 값 읽음.
- [ ] 파이프라인 A 바인딩 후 push constant 갱신 → **파이프라인 B** 바인딩. B가 바인딩되어도 push constant 값은 **재설정되지 않고 그대로 유지**. B의 동일 오프셋 영역에 A의 값이 그대로 남아 예상치 못한 동작 발생 가능.
- [ ] 같은 layout의 다른 range에 push constant 갱신 안 해서 이전 draw의 값이 남아 있음.
- [ ] secondary command buffer에서 push constant 갱신 후 primary에서 draw → secondary에는 `VkCommandBufferInheritanceRenderingInfo` 같은 inheritance 설정 없으면 일관성 깨질 수 있음.

### 8.4. secondary / inheritance

- [ ] secondary command buffer에 `VkCommandBufferInheritanceDescriptorHeapInfoEXT` 추가하고 push constants 무관 시 push 안 됨 (VUID-vkCmdPushConstants-commandBuffer-11295/11296).
- [ ] secondary에서 push 한 값이 primary의 push constant와 충돌 (Vulkan은 secondary 시작 시 push constant를 어떻게 다룸 — spec 확인 필요).

### 8.5. 큐 / stage

- [ ] video coding scope 안에서 `vkCmdPushConstants` 호출 (VUID-vkCmdPushConstants-videocoding).
- [ ] `stageFlags == 0` (VUID-stageFlags-requiredbitmask).
- [ ] `stageFlags`에 디바이스에 없는 shader stage 포함 (예: `TESSELLATION_CONTROL_BIT`인데 tessellation feature 비활성).
- [ ] compute 큐인데 `stageFlags = GRAPHICS_BIT`만 — 정상 (compute는 안 받음). 단 그 range 자체가 compute에서 무용.

### 8.6. 일반 / 실전

- [ ] push constant로 **큰 데이터**(수 KB) 넘기려고 함. 한계 초과. **UBO + dynamic offset**으로 가야 함.
- [ ] push constant를 **descriptor set 업데이트 대용**으로 사용 → 호환되는 파이프라인만 묶일 수 있어 위험.
- [ ] 셰이더가 `push_constant` 블록이 없는데 `vkCmdPushConstants` 호출 → **쓰긴 쓰지만** 셰이더가 안 읽음. 무효 동작.
- [ ] `vkCmdBindPipeline` 호출 후 `vkCmdPushConstants` 순서 — 일반적으로 **bind → push → draw**. 반대로 해도 값은 적용되지만 pipeline layout이 바뀌면 호환성 문제.
- [ ] 멀티 스레드에서 동시에 push constant 갱신 (command buffer는 외부 동기화 필요).
- [ ] `vkCmdPushConstants2`/`VkPushConstantsInfo`에 `layout = VK_NULL_HANDLE`인데 `dynamicPipelineLayout` feature 비활성 (VUID-VkPushConstantsInfo-None-09495).
- [ ] `VkPushConstantsInfo`에 `layout`이 `VK_NULL_HANDLE`인데 pNext에 `VkPipelineLayoutCreateInfo` 없음 (VUID-VkPushConstantsInfo-layout-09496).

---

---

## 9. 빠른 참조

| 의도 | 권장 |
|------|------|
| MVP/뷰 행렬 (per draw) | push constant VS, 64~128 B |
| 머티리얼 ID + per-instance ID | push constant VS or VS+FS, 4~16 B |
| 가변 인덱스 테이블 (per draw) | dynamic UBO offset |
| 큰 메쉬 데이터 (per draw) | SSBO + dynamic offset |
| 공유 셰이더 상수 (여러 draw) | 인라인 유니폼 블록 |
| 시간/프레임 정보 | push constant ALL_STAGES, 16 B |
| 머티리얼별 파라미터 블록 | descriptor set (UBO) |

| 한계 | 값 (보통) |
|------|----------|
| `maxPushConstantsSize` | 128~256 바이트 |
| 한 draw당 push cost | 한 자릿수 µs 미만 |
| 갱신 단위 | 4 바이트 정렬 |
| 갱신 명령 | 커맨드 버퍼에 기록 (draw 전) |

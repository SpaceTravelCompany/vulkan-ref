---
title: Command Buffer 관리
slug: command-buffers
---

## 소개

`VkCommandBuffer`는 **GPU에 모든 명령을 기록하는 유일한 통로**다. Pool로 할당하고, begin/end로 recording 상태를 관리하고, reset하거나 re-record하는 패턴을 잘 알아야 GPU 작업이 깨지지 않는다.

> **용어 정리**
> - **Command Pool**: `VkCommandPool`. 버퍼들을 묶어주는 할당자. 큐 패밀리별로 하나씩.
> - **Primary Command Buffer**: execute할 수 있는 버퍼. `vkQueueSubmit`에 직접 넘김.
> - **Secondary Command Buffer**: primary에서 `vkCmdExecuteCommands`로 호출. inheritance가 필요.
> - **Recording State**: `vkBeginCommandBuffer` → recording 중 → `vkEndCommandBuffer` → executable.
> - **Pending State**: `vkQueueSubmit` 후 GPU가 아직 처리 중인 상태.
> - **Reset**: 버퍼를 초기 상태로 되돌려 재사용. Pool 리셋으로 한 번에.

이 문서는 **Pool → 할당 → begin/end → submit → reset → free** 흐름과 자주 빠지는 주의사항을 다룬다.

---

---

## 1. `VkCommandPool` — 커맨드 풀

```c
typedef struct VkCommandPoolCreateInfo {
    VkStructureType             sType;
    const void*                 pNext;
    VkCommandPoolCreateFlags    flags;
    uint32_t                    queueFamilyIndex;
} VkCommandPoolCreateInfo;
```

### 1.1. `flags`

| 플래그 | 의미 |
|--------|------|
| `RESET_COMMAND_BUFFER_BIT` | 개별 버퍼를 `vkResetCommandBuffer`로 reset 가능. 없으면 pool 리셋만 가능. |
| `TRANSIENT_BIT` | 짧은 수명의 버퍼용. 드라이버에 메모리 절약 힌트. |
| `PROTECTED_BIT` | protected 커맨드 풀. protected 버퍼 전용. |

> **실전 권장** 무조건 `RESET_COMMAND_BUFFER_BIT`를 켠다. **이게 없으면** 개별 버퍼 reset이 불가능하고 pool 전체만 reset 가능 → 프레임단위 재사용이 귀찮아진다.

### 1.2. `queueFamilyIndex`

풀은 **특정 큐 패밀리**에 묶인다. 그래픽스/컴퓨트/트랜스퍼별 풀을 따로 만든다.

```c
VkCommandPoolCreateInfo cpci{};
cpci.sType            = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
cpci.flags            = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
cpci.queueFamilyIndex = graphicsQueueFamily; // vkGetPhysicalDeviceQueueFamilyProperties에서 찾은 graphics family

VkCommandPool graphicsPool;
vkCreateCommandPool(device, &cpci, nullptr, &graphicsPool);
```

**큐 패밀리 개수만큼 풀**. 보통 graphics 1개, compute 1개, transfer 1개. 각각 자기 큐에만 제출 가능.

---

---

## 2. `vkAllocateCommandBuffers` — 버퍼 할당

```c
VkCommandBufferAllocateInfo allocInfo{};
allocInfo.sType              = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
allocInfo.commandPool        = graphicsPool;
allocInfo.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;  // 또는 SECONDARY
allocInfo.commandBufferCount = 3;  // 예: 트리플 버퍼링용 3장

VkCommandBuffer cmds[3];
vkAllocateCommandBuffers(device, &allocInfo, cmds);
```

- 한 풀에서 필요한 만큼 버퍼 한 번에 할당 가능.
- 버퍼는 `vkFreeCommandBuffers`로 개별 해제하거나, pool 파괴 시 한 번에 정리.

---

---

## 3. `vkBeginCommandBuffer` / `vkEndCommandBuffer`

```c
VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;  // 또는 SIMULTANEOUS_USE_BIT

vkBeginCommandBuffer(cmd, &beginInfo);
// ... 명령 기록 ...
vkCmdDraw(...);
vkEndCommandBuffer(cmd);
```

### 3.1. `flags`

| 플래그 | 의미 | 권장 |
|--------|------|------|
| `ONE_TIME_SUBMIT_BIT` | 한 번 submit → reset → 다시 record | 가장 일반적 |
| `SIMULTANEOUS_USE_BIT` | submit 중에도 같은 버퍼로 다음 frame record 가능 | 멀티프레임 중복 submit 시 |
| `RENDER_PASS_CONTINUE_BIT` | secondary가 렌더 패스 안에서 실행될 때만 | secondary 전용 |

> **스펙 NOTE** "On some implementations, not using the `SIMULTANEOUS_USE_BIT` bit enables command buffers to be patched in-place if needed, rather than creating a copy of the command buffer."
>> **ONE_TIME_SUBMIT이 더 빠름** (드라이버가 in-place 패칭 가능). 보통 ONE_TIME_SUBMIT 권장.

### 3.2. `vkResetCommandBuffer` — 개별 버퍼 재활용

```c
vkResetCommandBuffer(cmd, VK_COMMAND_BUFFER_RESET_RELEASE_RESOURCES_BIT);  // 또는 0
// 이제 cmd는 초기 상태. vkBeginCommandBuffer 가능.
```

- `RESET_RELEASE_RESOURCES_BIT` 있으면 **메모리 자원을 풀로 반환**. 없으면 재사용을 위해 버퍼가 메모리를 보유. 보통 **0** (메모리 보유)이 더 빠름.
- 이 기능 사용하려면 **pool 생성 시 `RESET_COMMAND_BUFFER_BIT`** 필수.

---

---

## 4. `vkResetCommandPool` — 풀 전체 리셋

```c
vkResetCommandPool(device, graphicsPool, 0);  // 또는 VK_COMMAND_POOL_RESET_RELEASE_RESOURCES_BIT
```

- 풀 안의 **모든 버퍼가 초기 상태**로 돌아감.
- `RELEASE_RESOURCES_BIT` 있으면 메모리 해제.
- **pending state 버퍼가 있으면 리셋 불가** (VUID-vkResetCommandPool-commandPool-00040). fence로 완료 확인 후 호출.

> **스펙 원문** "Any primary command buffer allocated from another VkCommandPool that is in the recording or executable state and has a secondary command buffer allocated from commandPool recorded into it, becomes invalid."
>> 다른 풀의 primary가 이 풀의 secondary를 execute 중이었으면 그 primary도 invalid.

---

---

## 5. `vkFreeCommandBuffers` / `vkDestroyCommandPool`

```c
vkFreeCommandBuffers(device, graphicsPool, 3, cmds);  // 3장 해제
```

- free 시점에 해당 버퍼가 **pending state면 안 됨**.
- 다른 primary가 이 버퍼(secondary)를 execute 중이면 그 primary도 invalid.

```c
vkDestroyCommandPool(device, graphicsPool, nullptr);
```

- 풀 파괴 시 모든 버퍼가 자동으로 free.
- **pending state 버퍼가 있으면 파괴 불가** (VUID-vkDestroyCommandPool-commandPool-00041).
- `vkDeviceWaitIdle` → `vkDestroyCommandPool` 순서가 가장 안전.

---

---

## 6. Primary / Secondary

| | Primary | Secondary |
|---|---------|-----------|
| Execute | `vkQueueSubmit` 직접 | `vkCmdExecuteCommands`로 primary 안에서 |
| Begin | `vkBeginCommandBuffer` | `vkBeginCommandBuffer` + `pInheritanceInfo` 필수 |
| Inheritance | 불필요 | `VkCommandBufferInheritanceInfo`로 render pass/framebuffer 정보 |
| 재사용 | `SIMULTANEOUS_USE` 또는 ONE_TIME 후 free | 동일 |

**Secondary inheritance 구조:**

```c
VkCommandBufferInheritanceInfo inhInfo{};
inhInfo.sType       = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO;
inhInfo.renderPass  = renderPass;    // 호환되는 render pass
inhInfo.subpass     = 0;
inhInfo.framebuffer = framebuffer;   // 또는 VK_NULL_HANDLE
inhInfo.occlusionQueryEnable = VK_FALSE;  // secondary 안에서 occlusion query를 켤지
inhInfo.queryFlags  = 0;
inhInfo.pipelineStatistics = 0;

VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType            = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags            = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT
                           | VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT;
beginInfo.pInheritanceInfo = &inhInfo;

vkBeginCommandBuffer(secondary, &beginInfo);
// ... draw calls ...
vkEndCommandBuffer(secondary);

// primary에서 실행:
vkCmdBeginRenderPass(primary, &rpBeginInfo, VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS);
vkCmdExecuteCommands(primary, 1, &secondary);
vkCmdEndRenderPass(primary);
```

> **중첩 secondary**: `nestedCommandBuffer` feature 켜졌을 때 secondary 안에서 또 secondary 실행 가능. nesting depth 제한 있음 (`maxCommandBufferNestingLevel`).

### 6.1. Dynamic Rendering + Secondary Command Buffer

렌더 패스 객체 없이 `vkCmdBeginRendering`을 쓸 때 secondary command buffer는 **`VkCommandBufferInheritanceRenderingInfo`를 pNext에 연결**해야 한다.

```c
// secondary command buffer begin
VkCommandBufferInheritanceRenderingInfo inhRendering{};
inhRendering.sType                = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_RENDERING_INFO;
inhRendering.colorAttachmentCount = 1;  // primary의 color attachment 수와 일치
inhRendering.pColorAttachmentFormats = &(VkFormat){VK_FORMAT_R8G8B8A8_SRGB};
inhRendering.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;
inhRendering.rasterizationSamples  = VK_SAMPLE_COUNT_1_BIT;

VkCommandBufferInheritanceInfo inhInfo{};
inhInfo.sType       = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO;
inhInfo.pNext       = &inhRendering;  // ← dynamic rendering용 pNext
// renderPass, framebuffer, subpass는 VK_NULL_HANDLE/0

VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType            = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags            = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
beginInfo.pInheritanceInfo = &inhInfo;
vkBeginCommandBuffer(secondary, &beginInfo);
// ... draw calls ...
vkEndCommandBuffer(secondary);

// primary
vkCmdBeginRendering(primary, &(VkRenderingInfo){
    .flags = VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT,
    .renderArea = {{0,0},{W,H}},
    .layerCount = 1,
    .colorAttachmentCount = 1,
    .pColorAttachments = &colorAttach,
    .pDepthAttachment   = &depthAttach,
});
vkCmdExecuteCommands(primary, 1, &secondary);
vkCmdEndRendering(primary);
```

> **스펙 원문 (VUID-vkCmdExecuteCommands-flags-06026)** `flags` member of `VkCommandBufferInheritanceRenderingInfo` must be equal to the `VkRenderingInfo::flags` parameter to `vkCmdBeginRendering`, excluding `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT`.
> **VUID-vkCmdExecuteCommands-colorAttachmentCount-06027** `colorAttachmentCount` must be equal to `vkCmdBeginRendering`'s `colorAttachmentCount`.
>> primary와 secondary의 포맷/개수 불일치가 가장 흔한 VUID 실수.

---

---

## 7. Command Buffer 수명 주기

```
  Initial → Recording → Executable → Pending → Invalid
    ↑          ↓           ↓            ↓
    └─── Reset ──────────────┘            │
                                          │
    DestroyPool ←──────────────────────────┘ (pending 제외)
```

| 상태 | 설명 |
|------|------|
| **Initial** | `vkAllocateCommandBuffers` 직후, `vkResetCommandBuffer`/`vkResetCommandPool` 후 |
| **Recording** | `vkBeginCommandBuffer` → `vkEndCommandBuffer` 사이. 명령 기록 가능. |
| **Executable** | `vkEndCommandBuffer` 직후. `vkQueueSubmit` 가능. |
| **Pending** | `vkQueueSubmit` 후 GPU 처리 중. fence가 signal 될 때까지 이 상태. |
| **Invalid** | 다른 primary에서 execute된 secondary가 pool 리셋되면 그 primary가 invalid. |

---

---

## 8. 전형적 패턴

### 8.1. 매 프레임 재기록 (ONE_TIME_SUBMIT)

```c
// 프레임 시작 시 reset
vkResetCommandBuffer(cmd, 0);
vkBeginCommandBuffer(cmd, &beginInfo);  // ONE_TIME_SUBMIT
// ... 기록 ...
vkEndCommandBuffer(cmd);

// submit
vkQueueSubmit(queue, 1, &submit, frameFence);

// fence wait 후 다음 프레임에 다시 reset → begin → ... → end → submit
```

### 8.2. 한 번 기록 후 반복 (SIMULTANEOUS_USE)

```c
// 초기화 1회
vkBeginCommandBuffer(cmd, &(VkCommandBufferBeginInfo){
    .flags = VK_COMMAND_BUFFER_USAGE_SIMULTANEOUS_USE_BIT,
});
// ... 영구적인 명령 (예: 풀스크린 quad, post-process) ...
vkEndCommandBuffer(cmd);

// 매 프레임 submit만 반복
vkQueueSubmit(queue, 1, &submit, fence);
// cmd는 reset/re-record 안 함
```

### 8.3. Pool 별 용도 분리 + Reset

```c
// graphics pool: frame commands
VkCommandBufferAllocateInfo fci{};
fci.commandPool = graphicsPool;
fci.level       = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
fci.commandBufferCount = 3;  // triple buffer
vkAllocateCommandBuffers(device, &fci, frameCmds);

// staging pool: upload commands
fci.commandPool = stagingPool;
fci.commandBufferCount = 1;
vkAllocateCommandBuffers(device, &fci, &uploadCmd);

// 매 프레임
vkResetCommandPool(device, stagingPool, 0);  // upload cmd 초기화
vkBeginCommandBuffer(uploadCmd, &beginInfo); // ONE_TIME_SUBMIT
// ... copy ...
vkEndCommandBuffer(uploadCmd);
vkQueueSubmit(transferQueue, 1, &uploadSubmit, uploadFence);
```

---

---

## 9. 자주 빠지는 주의사항 모음

### 9.1. Pool

- [ ] `queueFamilyIndex`가 **버퍼를 submit할 큐와 일치하지 않음** → `vkQueueSubmit`에서 VUID 오류.
- [ ] `RESET_COMMAND_BUFFER_BIT` 없이 개별 버퍼 reset 시도 → 기능 미지원.
- [ ] `TRANSIENT_BIT`를 켜고 버퍼를 **반복 재사용** → VUID는 아니지만 성능 저하 가능 (짧은 수명 힌트 위반).
- [ ] `vkResetCommandPool`/`vkDestroyCommandPool` 시 **pending 버퍼** 존재 (VUID-commandPool-00040/00041).
- [ ] graphics/transfer/compute 용 pool을 하나로 통합 → 각기 다른 `queueFamilyIndex` 불일치.

### 9.2. Begin/End

- [ ] `ONE_TIME_SUBMIT_BIT`로 기록한 버퍼를 **다시 submit** → `vkBeginCommandBuffer` 없이 submit 시도.
- [ ] `SIMULTANEOUS_USE_BIT` 없이 submit 중에 같은 버퍼를 다시 begin → UB.
- [ ] Secondary begin 시 `pInheritanceInfo` 누락.
- [ ] Dynamic rendering에서 secondary 사용 시 `VkCommandBufferInheritanceRenderingInfo` pNext 누락.
- [ ] **render pass 밖에서** `RENDER_PASS_CONTINUE_BIT`로 begin한 secondary를 execute → VUID.

### 9.3. Execute (secondary)

- [ ] primary의 render pass와 secondary의 `subpass`가 불일치.
- [ ] `VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS` 없이 `vkCmdExecuteCommands` → VUID.
- [ ] 같은 primary에 두 번 이상 execute (해당 secondary가 `SIMULTANEOUS_USE` 아니면 UB).
- [ ] secondary 안에서 occlusion query를 begin/end하려는데 `occlusionQueryEnable = VK_FALSE` → VUID.
- [ ] `nestedCommandBuffer` feature 없이 secondary 안에서 `vkCmdExecuteCommands` → VUID.

### 9.4. Reset

- [ ] `vkResetCommandBuffer` 시 **해당 버퍼를 execute 중인 다른 primary**가 존재 → 그 primary가 invalid.
- [ ] `RELEASE_RESOURCES_BIT`를 **매 프레임** 사용 → 매번 메모리 재할당으로 느림.
- [ ] `vkResetCommandPool` 호출 시점에 다른 primary가 이 풀의 secondary를 execute 중 → primary가 invalid.
- [ ] 모바일/타일 GPU에서는 reset 성능 특성이 다를 수 있음 — **가능한 한 Record+Submit+Reset 패턴**으로.

### 9.5. 일반 / 실전

- [ ] `vkFreeCommandBuffers` 없이 pool만 파괴 → 내부 버퍼 정리되지만 명시적 free가 더 의도 명확.
- [ ] `End` 없이 `vkResetCommandBuffer` 호출 → recording 상태 버퍼의 초기화. 명시적 end 권장.
- [ ] `SIMULTANEOUS_USE_BIT`로 기록한 버퍼를 **두 큐에 동시 submit** → UB. 한 큐에 중복 submit은 허용, 서로 다른 큐는 불가.
- [ ] 같은 command buffer를 `vkQueueSubmit` 직후 **pool 리셋** → 아직 pending 상태 → VUID. **fence로 확실하게**.
- [ ] **멀티스레드**에서 같은 pool의 버퍼를 동시에 record → 외부 동기화 필요. 보통 스레드별로 별도 pool.
- [ ] pool 생성/파괴를 **매 프레임** → 풀 생성 비용 큼. 재사용 권장.
- [ ] `vkTrimCommandPool`로 사용하지 않는 메모리 반환 가능 (memory pressure 상황).

---

---

## 10. 빠른 참조

| 의도 | 권장 |
|------|------|
| 일반 frame draw | `ONE_TIME_SUBMIT` + 매 frame reset + re-record |
| 풀스크린 post-process | `SIMULTANEOUS_USE`로 한 번만 record |
| 멀티스레드 | 스레드별 pool |
| GUI / UI commands | 별도 transfer pool |
| 스테이징 업로드 | ONE_TIME_SUBMIT transfer pool |
| 메모리 압박 | `vkTrimCommandPool` |
| GPU idle 보장 | `vkDeviceWaitIdle` 후 pool 리셋/파괴 |

| 상태 전이 | API |
|-----------|-----|
| Initial → Recording | `vkBeginCommandBuffer` |
| Recording → Executable | `vkEndCommandBuffer` |
| Executable → Pending | `vkQueueSubmit` |
| Pending → Executable | fence signal |
| Any(except Pending) → Initial | `vkResetCommandBuffer` 또는 `vkResetCommandPool` |
| Any(except Pending) → 삭제 | `vkFreeCommandBuffers` 또는 `vkDestroyCommandPool` |

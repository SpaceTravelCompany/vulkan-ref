---
title: Validation & Debug
slug: validation-and-debug
---

## 소개

Vulkan은 명시적 API라 잘못 써도 GPU가 조용히 작동할 수 있다. **Validation layer**는 표준 위반·동기화 누락·자원 수명 오류 등을 실행 전에 잡아주는 핵심 디버깅 도구다. 그리고 `VK_EXT_debug_utils`는 콜백, 객체 이름, GPU 측 라벨 등 풍부한 인스펙션 인터페이스를 제공한다.

> **용어 정리**
> - **Validation Layer**: Vulkan 호출을 가로채 표준 위반을 검사하는 플러그인. `VK_LAYER_KHRONOS_validation`이 표준 묶음.
> - **Messenger**: 콜백 함수. 검증/성능/일반 메시지를 앱이 받아 처리 (`VK_EXT_debug_utils`).
> - **VUID**: Vulkan Unique ID. 검증 메시지 ID. `VUID-VkBufferCreateInfo-usage-09500` 같은 형태.
> - **Debug Region**: 커맨드 버퍼/큐에 붙는 이름. RenderDoc/프로파일러에서 시각화.
> - **GPU-assisted**: 셰이더를 계측해 GPU 측 오류(드로우 후 사용 등)까지 검출.

이 문서는 **layer 켜기 → 콜백 → 객체 이름 → 라벨 → 실전 팁** 흐름을 다룬다.

---

## 1. 큰 그림

```flowchart
flowchart TD
  A["VkInstance 생성 시 VK_EXT_debug_utils + VK_LAYER_KHRONOS_validation 요청"]
  B["pNext: VkDebugUtilsMessengerCreateInfoEXT — 인스턴스 destroy까지 모든 메시지 수신"]
  C["pNext: VkValidationFeaturesEXT — best practices, sync validation 켜기"]
  D(["vkCreateInstance"])
  E["[vkDestroyInstance까지] 콜백으로 메시지 수신"]
  F["messageSeverity: ERROR + WARNING + INFO"]
  G["messageType: VALIDATION + GENERAL + PERFORMANCE"]
  H["(개별 객체에 이름)"]
  I(["vkSetDebugUtilsObjectNameEXT(VK_OBJECT_TYPE_IMAGE, handle, HDR_Target)"])
  J["(커맨드 버퍼에 라벨)"]
  K(["vkCmdBeginDebugUtilsLabelEXT(cmd, Shadow Pass, color)"])
  L["... draw ..."]
  M(["vkCmdEndDebugUtilsLabelEXT(cmd)"])
  A --> B --> C --> D --> E
  E --> F
  E --> G
  E --> H --> I
  I --> J --> K --> L --> M
```

**핵심 포인트:**

- 인스턴스/디바이스 lifetime 동안 **인스턴스 destroy까지** 모든 메시지를 받으려면 `pNext`에 messenger를 연결한다.
- **출시 빌드에는 layer를 끄고** `VK_EXT_debug_utils` extension 자체도 빼는 게 일반적이다 (콜백 함수가 nullptr가 되어도 OK, layer는 보통 instance create에서만 동작).
- 객체에 **이름을 다는 습관**은 validation 메시지의 가독성을 비약적으로 올린다.

---

## 2. Validation Layer

### 2.1. `VK_LAYER_KHRONOS_validation`

- LunarG의 표준 검증 레이어 묶음. `core check` + `thread safety` + `object lifetime` + `shader instrumentation` 등 포함.
- **Vulkan SDK 설치 시 자동 포함**. SDK 미설치 환경에서는 별도 다운로드.
- 인스턴스 생성 시 `ppEnabledLayerNames`에 이름을 넣거나, **환경변수**로도 활성화 가능:
  - `VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation` (Windows에서는 보통 SDK 설치 시 시스템 환경에 등록)

```c
// 명시적 활성화
VkInstanceCreateInfo ici{};
ici.enabledLayerCount = 1;
ici.ppEnabledLayerNames = (const char*[]){"VK_LAYER_KHRONOS_validation"};
```

> **실전 팁** 디버그 빌드에서는 명시적 활성화를 권장. 환경변수 의존은 CI 같은 비표준 환경에서 깨질 수 있다.

### 2.2. `VK_EXT_validation_features` — 기능별 on/off

`VkValidationFeaturesEXT`를 `VkInstanceCreateInfo::pNext`에 추가해 **세부 기능**을 조정한다.

```c
VkValidationFeaturesEXT vf{};
vf.sType = VK_STRUCTURE_TYPE_VALIDATION_FEATURES_EXT;

// 켜기
VkValidationFeatureEnableEXT enables[] = {
    VK_VALIDATION_FEATURE_ENABLE_BEST_PRACTICES_EXT,
    VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT,
    VK_VALIDATION_FEATURE_ENABLE_GPU_ASSISTED_EXT,
};
vf.enabledValidationFeatureCount = 3;
vf.pEnabledValidationFeatures = enables;

// 끄기 (선택)
VkValidationFeatureDisableEXT disables[] = {
    // VK_VALIDATION_FEATURE_DISABLE_THREAD_SAFETY_EXT,  // 멀티스레드 비활성화 시
};
vf.disabledValidationFeatureCount = 0;
vf.pDisabledValidationFeatures = disables;

ici.pNext = &vf;
```

| Enable 플래그 | 의미 |
|--------------|------|
| `GPU_ASSISTED_EXT` | 셰이더 계측으로 GPU 측 사용 오류 검출 (성능 비용 큼) |
| `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT` | GPU-assisted가 descriptor set 슬롯 하나를 미리 예약 |
| `BEST_PRACTICES_EXT` | 명시적 위반은 아니지만 권장 위반 경고 |
| `DEBUG_PRINTF_EXT` | 셰이더의 `debugPrintfEXT` 출력을 콜백으로 전달 |
| `SYNCHRONIZATION_VALIDATION_EXT` | 동기화 누락으로 인한 race 검출 (필수 권장) |

| Disable 플래그 | 의미 |
|---------------|------|
| `ALL_EXT` | 모든 검증 끔 (디버그 끄기 용도) |
| `SHADERS_EXT` | 셰이더 검증 끔. SPIR-V가 깨끗할 때만 |
| `THREAD_SAFETY_EXT` | 멀티스레드 안전성 검사 끔. 단일 스레드에서 사용 시 |
| `API_PARAMETERS_EXT` | 파라미터 무결성 검사 끔 |
| `OBJECT_LIFETIMES_EXT` | 객체 수명 검사 끔 |
| `CORE_CHECKS_EXT` | 핵심 검사 끔. **`SHADERS_EXT`를 함의** |
| `UNIQUE_HANDLES_EXT` | 중복 핸들 검사 끔 |
| `SHADER_VALIDATION_CACHE_EXT` | 셰이더 검증 결과 캐시 끔 |

> **스펙 원문 (VUID-VkValidationFeaturesEXT-pEnabledValidationFeatures-02967)** If `pEnabledValidationFeatures` array contains `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT`, then it must also contain `GPU_ASSISTED_EXT` or `DEBUG_PRINTF_EXT`.
>> reserved slot을 켜면 그 사용처(GPU-assisted 또는 debug_printf)도 함께 켜야 한다.

> **NOTE (스펙 발췌)** "Disabling checks such as parameter validation and object lifetime validation prevents the reporting of error conditions that can cause other validation checks to behave incorrectly or crash. Some validation checks assume that their inputs are already valid and do not always revalidate them."
>> 일부 disable은 **다른 검증의 안전성을 깨뜨릴 수 있다**. 가능하면 핵심(`API_PARAMETERS`, `OBJECT_LIFETIMES`, `CORE_CHECKS`)은 유지.

### 2.3. 권장 디버그 프리셋

| 모드 | layer | enable 플래그 | disable 플래그 |
|------|-------|--------------|----------------|
| **개발 표준** | `VK_LAYER_KHRONOS_validation` | `BEST_PRACTICES`, `SYNCHRONIZATION_VALIDATION` | (없음) |
| **GPU 측 검증** | `VK_LAYER_KHRONOS_validation` | 위 + `GPU_ASSISTED`(+`GPU_ASSISTED_RESERVE_BINDING_SLOT`) | (없음) |
| **성능 프로파일** | `VK_LAYER_KHRONOS_validation` | (없음) | `THREAD_SAFETY`는 유지, 그 외는 케이스별 |
| **출시 빌드** | (없음) | — | — |

---

## 3. `VK_EXT_debug_utils` — Messenger

> **스펙 원문** "The application should always return `VK_FALSE`. The `VK_TRUE` value is reserved for use in layer development."
>> 사용자 콜백은 항상 `VK_FALSE` 반환. `VK_TRUE`는 레이어 개발 전용.

### 3.1. 콜백 등록

```c
typedef VkBool32 (VKAPI_PTR *PFN_vkDebugUtilsMessengerCallbackEXT)(
    VkDebugUtilsMessageSeverityFlagBitsEXT       messageSeverity,
    VkDebugUtilsMessageTypeFlagsEXT              messageTypes,
    const VkDebugUtilsMessengerCallbackDataEXT*  pCallbackData,
    void*                                        pUserData);

// 인스턴스 생성 전/pNext에 끼우기
VkDebugUtilsMessengerCreateInfoEXT mci{};
mci.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT;
mci.messageSeverity =
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
mci.messageType =
    VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
    VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
mci.pfnUserCallback = myDebugCallback;
mci.pUserData = nullptr;  // 필요시 this 등

VkInstanceCreateInfo ici{};
ici.pNext = &mci;  // VkValidationFeaturesEXT와 체이닝 시 둘 다 pNext
vkCreateInstance(&ici, nullptr, &instance);
```

> **스펙 원문** "The callback must not make calls to any Vulkan commands" (VUID-PFN_vkDebugUtilsMessengerCallbackEXT-None-04769)
>> 콜백 안에서 Vulkan API를 호출하면 안 된다. 로그만 찍거나 atomic 플래그 정도만.

### 3.2. 콜백 트리거 조건

1. 이벤트의 `messageSeverity`와 messenger의 `messageSeverity`의 bitwise AND가 0이면 스킵.
2. AND 결과가 0이 아니면 `messageType`도 같은 검사.
3. 둘 다 통과하면 콜백 호출.

### 3.3. 콜백 데이터 — `VkDebugUtilsMessengerCallbackDataEXT`

```c
typedef struct VkDebugUtilsMessengerCallbackDataEXT {
    VkStructureType                              sType;
    const void*                                  pNext;
    VkDebugUtilsMessengerCallbackDataFlagsEXT    flags;
    const char*                                  pMessageIdName;     // VUID 문자열 (검증 메시지의 경우)
    int32_t                                      messageIdNumber;
    const char*                                  pMessage;           // 사람 읽을 메시지
    uint32_t                                     queueLabelCount;
    const VkDebugUtilsLabelEXT*                  pQueueLabels;
    uint32_t                                     cmdBufLabelCount;
    const VkDebugUtilsLabelEXT*                  pCmdBufLabels;
    uint32_t                                     objectCount;
    const VkDebugUtilsObjectNameInfoEXT*         pObjects;           // 관련 객체 이름
} VkDebugUtilsMessengerCallbackDataEXT;
```

- `pMessageIdName`이 **VUID**(예: `VUID-VkBufferCreateInfo-usage-09500`)라서, 이걸 그대로 검색하면 스펙 문서의 해당 VUID 항목을 바로 찾을 수 있다.
- `pObjects`에 들어오는 객체는 `vkSetDebugUtilsObjectNameEXT`로 이름을 단 경우 그 이름이 함께 출력된다.

### 3.4. 메시지 종류와 해석

| Type | 의미 | 어디서 옴 |
|------|------|----------|
| `GENERAL` | 레이어 무관 일반 메시지 | 드라이버, 로더, 사용자가 `vkSubmitDebugUtilsMessageEXT`로 보낸 것 |
| `VALIDATION` | 검증 위반 | `VK_LAYER_KHRONOS_validation` |
| `PERFORMANCE` | 성능 권고 | `VK_LAYER_KHRONOS_validation` (best practices 등) |
| `DEVICE_ADDRESS_BINDING_EXT` | device address 변경 알림 | device address binding 관련 extension |

---

## 4. 객체 이름 — `vkSetDebugUtilsObjectNameEXT`

검증 메시지가 `Image 0xc0dec0de...`라고만 나오면 디버깅이 지옥이다. **이름을 다는 습관**이 핵심.

```c
// 함수 포인터 로드
PFN_vkSetDebugUtilsObjectNameEXT pfnSetName =
    (PFN_vkSetDebugUtilsObjectNameEXT)vkGetDeviceProcAddr(device, "vkSetDebugUtilsObjectNameEXT");

VkDebugUtilsObjectNameInfoEXT name{};
name.sType        = VK_STRUCTURE_TYPE_DEBUG_UTILS_OBJECT_NAME_INFO_EXT;
name.objectType   = VK_OBJECT_TYPE_IMAGE;
name.objectHandle = (uint64_t)image;
name.pObjectName  = "HDR_Target";
pfnSetName(device, &name);
```

이후 검증 메시지는:
```
Image 'HDR_Target' (0xc0dec0dedeadbeef) is used in a command buffer
with no memory bound to it.
```

이렇게 **이름이 함께** 나온다. VUID와 함께 검색하면 즉시 원인 파악.

### 4.1. 어디에 이름을 다는가

| 객체 | 언제 다는가 |
|------|-----------|
| `VkInstance` | "AppName_Instance" |
| `VkDevice` | "GPU0" 등 (멀티 GPU 시) |
| `VkPhysicalDevice` | 보통 안 달아도 됨 (드라이버가 이름 표시) |
| `VkQueue` | "GraphicsQ", "PresentQ", "TransferQ" |
| `VkCommandPool` / `VkCommandBuffer` | "ShadowPass_Pool" / "ShadowPass_Cmd" |
| `VkBuffer` | "VertexBuffer_MeshA", "Uniform_PerFrame" |
| `VkImage` | "HDR_Target", "ShadowAtlas_2K" |
| `VkImageView` | 보통 image 이름 + 사용처 ("HDR_Target.SRV") |
| `VkSampler` | "LinearClamp", "Aniso8_Wrap" |
| `VkPipeline` | "GBuffer_Pipe", "Forward_Pipe" |
| `VkPipelineLayout` | "GBuffer_Layout" |
| `VkDescriptorSet` | "MaterialSet_Frame0" |
| `VkRenderPass` / `VkFramebuffer` | "GBuffer_RP", "GBuffer_FB" |
| `VkSemaphore` / `VkFence` | "ImageAvailable_Frame0" 등 |
| `VkSwapchainKHR` | "MainSwapchain" |

> **스펙 원문 (스펙 발췌)** "The graphicsPipelineLibrary feature allows the specification of pipelines without the creation of `VkShaderModule` objects beforehand... `VkDebugUtilsObjectNameInfoEXT` can be included in the pNext chain of `VkPipelineShaderStageCreateInfo`..."
>> `graphicsPipelineLibrary`로 모듈 없이 파이프라인을 만들 때, 셰이더 이름을 **파이프라인 생성 시** 미리 박을 수 있다.

### 4.2. 성능 영향

이름 다는 작업은 **메타데이터 dict에 한 줄 추가**하는 수준이라 GPU 성능에 영향 없음. 단 string 복사가 발생하므로 **핫 루프에서 매 프레임 갱신은 피해야** 한다. 한 번 다는 게 정석.

---

## 5. Debug Region — 라벨 (GPU 측 시각화)

RenderDoc, Vulkan Configurator, NSight 등 외부 도구가 **커맨드 버퍼/큐에 박힌 라벨**을 시각화한다. 타임라인에서 "Shadow Pass" 같은 영역이 색깔로 구분되어 보임.

### 5.1. 큐 라벨

```c
PFN_vkQueueBeginDebugUtilsLabelEXT pfnBegin =
    (PFN_vkQueueBeginDebugUtilsLabelEXT)vkGetInstanceProcAddr(instance, "vkQueueBeginDebugUtilsLabelEXT");
PFN_vkQueueEndDebugUtilsLabelEXT pfnEnd = ...;

VkDebugUtilsLabelEXT label{};
label.sType      = VK_STRUCTURE_TYPE_DEBUG_UTILS_LABEL_EXT;
label.pLabelName = "Frame 1234";
label.color      = {1.0f, 0.5f, 0.0f, 1.0f};  // RGBA

pfnBegin(queue, &label);
vkQueueSubmit(queue, ...);  // 이 submit에 라벨 부착
pfnEnd(queue);
```

### 5.2. 커맨드 버퍼 라벨

```c
PFN_vkCmdBeginDebugUtilsLabelEXT pfnCmdBegin = ...;

pfnCmdBegin(cmd, &label);   // {pLabelName="Shadow Pass", color={0,1,0,1}}
vkCmdBeginRenderPass(cmd, ...);
// draws...
vkCmdEndRenderPass(cmd);
pfnCmdEnd(cmd);
```

라벨은 **중첩 가능**. RenderDoc에서 호출 스택 형태로 보임.

### 5.3. `vkCmdInsertDebugUtilsLabelEXT`

영역이 아니라 **단일 시점 표시**에 사용. 타임라인에 점선 마커로 표시.

```c
pfnCmdInsert(cmd, &(VkDebugUtilsLabelEXT{
    .sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_LABEL_EXT,
    .pLabelName = "GPU Particle Update",
}));
```

### 5.4. 성능 영향

- 라벨은 **메타데이터만** 기록. CPU 측에서 약간의 string 처리 발생하지만 GPU 영향 없음.
- 프로덕션에서도 디버깅에 도움 되니 **남겨두는 게 권장**. 끄고 싶다면 `VK_EXT_debug_utils`를 디바이스 extension에서 빼면 모든 라벨 호출이 무시됨 (이 경우 함수 포인터를 못 얻으므로 호출 자체가 컴파일되지 않게 매크로 가드 필요).

---

## 6. `vkSubmitDebugUtilsMessageEXT` — 앱이 직접 메시지 보내기

검증/성능/일반 메시지를 **콜백 흐름에 직접 주입**할 수 있다. 로깅/통계/원격 분석 연동에 유용.

```c
PFN_vkSubmitDebugUtilsMessageEXT pfnSubmit =
    (PFN_vkSubmitDebugUtilsMessageEXT)vkGetInstanceProcAddr(instance, "vkSubmitDebugUtilsMessageEXT");

VkDebugUtilsMessengerCallbackDataEXT data{};
data.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CALLBACK_DATA_EXT;
data.pMessageIdName = "AppInfo.FrameStart";
data.messageIdNumber = 0;
data.pMessage = "Frame 1234 started";

pfnSubmit(instance,
    VK_DEBUG_UTILS_MESSAGE_SEVERITY_INFO_BIT_EXT,
    VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT,
    &data);
```

콜백이 messageSeverity/messageType 필터에 부합하면 호출된다.

---

## 7. RenderDoc / 외부 도구 연동

- **RenderDoc**: Vulkan 지원. 앱이 VK_EXT_debug_utils로 단 이름이 RenderDoc 캡처에서도 그대로 보임. RenderDoc의 "Resource Inspector"에서 이름으로 검색 가능.
- **Vulkan Configurator (SDK)**: layer 활성/비활성, GPU-assisted 설정 등 GUI.
- **NSight Graphics / Vulkan**: 같은 라벨을 시각화. 멀티 GPU 디버깅에도 유용.

> **팁** RenderDoc 캡처를 뜰 때 검증 layer가 켜져 있으면 캡처 로드 시 validation 메시지가 같이 출력되어 추가 디버깅 단서가 된다.

---

## 8. 자주 빠지는 주의사항 모음

### 8.1. 인스턴스 / messenger

- [ ] `VK_EXT_debug_utils` extension을 요청 안 함 → messenger 함수 포인터가 nullptr.
- [ ] Messenger 콜백에서 **Vulkan API 호출** (VUID-PFN_vkDebugUtilsMessengerCallbackEXT-None-04769).
- [ ] Messenger 콜백에서 `VK_TRUE` 반환 (스펙 발췌: "always return VK_FALSE").
- [ ] `vkDestroyDebugUtilsMessengerEXT` 호출 후 콜백 호출 가능성 — 보통 destroy 후 추가 메시지는 무시되지만, 별도 스레드에서 호출되면 안전을 위해 플래그 검사.
- [ ] 인스턴스 destroy 후 messenger destroy 호출. messenger가 instance 자식이라 instance destroy에 **자동으로 정리되지만** 명시적 destroy가 더 명확.
- [ ] `vkCreateDebugUtilsMessengerEXT`를 instance create 이후에 호출할 때 — 그 시점까지의 메시지는 못 받음. **모든 메시지를 받으려면 pNext에 체이닝**.

### 8.2. Validation features

- [ ] `GPU_ASSISTED_RESERVE_BINDING_SLOT_EXT`만 켜고 `GPU_ASSISTED_EXT`/`DEBUG_PRINTF_EXT`를 안 켬 (VUID-pEnabledValidationFeatures-02967).
- [ ] `CORE_CHECKS_EXT`를 disable하면 `SHADERS_EXT`가 자동으로 disable됨. 셰이더만 끄고 싶다면 명시적으로 `SHADERS_EXT`만.
- [ ] `API_PARAMETERS` / `OBJECT_LIFETIMES` / `CORE_CHECKS`를 disable하면 다른 검증이 깨질 수 있음 (스펙 NOTE). 디버그 빌드에서는 가급적 유지.
- [ ] `VK_LAYER_KHRONOS_validation`을 `ppEnabledLayerNames`에 명시 안 하고 환경변수에만 의존 → CI에서 환경변수가 비어 있으면 검증 안 됨.

### 8.3. 객체 이름

- [ ] 이름에 **개행/null** 등 잘못된 문자열 — name은 null-terminated UTF-8.
- [ ] `pObjectName = NULL` 또는 빈 문자열 → **이전 이름 제거**. 일부러 지울 때 외엔 항상 의미 있는 이름 부여.
- [ ] 같은 객체에 여러 번 이름 갱신 — 정상 동작하지만 매 프레임 갱신은 비효율.
- [ ] `objectType`이 실제 객체와 불일치 (예: `IMAGE`인데 `BUFFER` 핸들).
- [ ] Destroy된 객체의 이름을 갱신 — UB. lifetime 추적 필요.

### 8.4. 라벨

- [ ] `vkCmdBeginDebugUtilsLabelEXT` ↔ `vkCmdEndDebugUtilsLabelEXT` 짝 안 맞음 (스택 불균형). **LunarG validation이 잡아줌**.
- [ ] 큐 라벨은 `vkQueueSubmit` 한 번에 부착됨 — submit 간 누적되지 않음. 매 submit마다 begin/end.
- [ ] 함수 포인터를 `vkGetInstanceProcAddr`로 받는데 디바이스 메서드인 경우 — `vkGetDeviceProcAddr` 사용.
- [ ] 프로덕션에서 `VK_EXT_debug_utils`를 빼면 함수 포인터가 nullptr이 됨. `if (pfnBegin) pfnBegin(...)` 가드 또는 빌드 시 `#ifdef DEBUG` 매크로 처리.

### 8.5. 일반 / 성능

- [ ] 콜백이 무거워서 **메인 스레드 블로킹** → 콜백에서는 **lock-free 큐에 push**만 하고 별도 스레드가 처리.
- [ ] GPU-assisted 켠 상태로 성능 측정 → 결과가 정상 성능이 아님. 프로파일링 시 **layer 끄기**.
- [ ] 콜백에서 printf 매 호출 → 성능 저하. 가능하면 **rate limit** 또는 severity ERROR만 즉시 출력.
- [ ] validation layer가 dev 디바이스를 못 찾음 → SDK 설치 또는 `VK_LAYER_PATH` 환경변수 확인.

---

## 9. 빠른 참조 — 인스턴스 생성 시 전형적 코드

```c
// 1) 사용 가능 레이어 확인
uint32_t layerCount;
vkEnumerateInstanceLayerProperties(&layerCount, nullptr);
std::vector<VkLayerProperties> layers(layerCount);
vkEnumerateInstanceLayerProperties(&layerCount, layers.data());
bool hasValidation = std::any_of(layers.begin(), layers.end(),
    [](auto& l) { return strcmp(l.layerName, "VK_LAYER_KHRONOS_validation") == 0; });

// 2) pNext 체인 구성
VkDebugUtilsMessengerCreateInfoEXT mci{};
mci.sType = VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT;
mci.messageSeverity = VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT |
                      VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT;
mci.messageType = VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT |
                  VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT |
                  VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT;
mci.pfnUserCallback = debugCallback;
mci.pUserData = nullptr;

VkValidationFeaturesEXT vf{};
vf.sType = VK_STRUCTURE_TYPE_VALIDATION_FEATURES_EXT;
VkValidationFeatureEnableEXT enables[] = {
    VK_VALIDATION_FEATURE_ENABLE_BEST_PRACTICES_EXT,
    VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT,
};
vf.enabledValidationFeatureCount = 2;
vf.pEnabledValidationFeatures = enables;

mci.pNext = &vf;  // messenger와 체이닝

// 3) 인스턴스 생성
VkApplicationInfo ai{};
ai.sType        = VK_STRUCTURE_TYPE_APPLICATION_INFO;
ai.pApplicationName = "MyApp";
ai.applicationVersion = VK_MAKE_VERSION(1, 0, 0);
ai.pEngineName  = "MyEngine";
ai.engineVersion = VK_MAKE_VERSION(1, 0, 0);
ai.apiVersion   = VK_API_VERSION_1_3;

VkInstanceCreateInfo ici{};
ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
ici.pApplicationInfo = &ai;
ici.enabledLayerCount = hasValidation ? 1u : 0u;
ici.ppEnabledLayerNames = hasValidation
    ? (const char*[]){"VK_LAYER_KHRONOS_validation"}
    : nullptr;
ici.enabledExtensionCount = hasValidation ? 1u : 0u;
ici.ppEnabledExtensionNames = hasValidation
    ? (const char*[]){"VK_EXT_debug_utils"}
    : nullptr;
ici.pNext = &mci;

vkCreateInstance(&ici, nullptr, &instance);
```

콜백 함수:

```c
static VKAPI_ATTR VkBool32 VKAPI_CALL debugCallback(
    VkDebugUtilsMessageSeverityFlagBitsEXT       severity,
    VkDebugUtilsMessageTypeFlagsEXT              types,
    const VkDebugUtilsMessengerCallbackDataEXT*  data,
    void*                                        user)
{
    const char* sev = (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT)   ? "ERROR"
                    : (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT) ? "WARN"
                    : (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_INFO_BIT_EXT)    ? "INFO"
                    : "VERBOSE";
    fprintf(stderr, "[%s][%s] %s (VUID: %s)\n",
        sev,
        (types & VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT) ? "VALIDATION" : "GENERAL",
        data->pMessage,
        data->pMessageIdName ? data->pMessageIdName : "(no-VUID)");
    return VK_FALSE;
}
```

---

## 10. 자주 보이는 VUID 카테고리

| 카테고리 | 예시 VUID | 흔한 원인 |
|----------|----------|----------|
| `usage` 누락/무효 | `VUID-VkBufferCreateInfo-usage-...` | buffer/image usage에 의도한 비트 빠뜨림 |
| `size` 0 | `VUID-VkBufferCreateInfo-size-...` | 빈 버퍼 생성 |
| `mipLevels/arrayLayers` 0 | `VUID-VkImageCreateInfo-mipLevels-...` | mip 0개 |
| `initialLayout` 잘못 | `VUID-VkImageCreateInfo-initialLayout-...` | UNDEFINED가 아닌 값 |
| `queueFamilyIndex` 중복 | `VUID-VkBufferCreateInfo-sharingMode-...` | CONCURRENT인데 중복 인덱스 |
| `sType` 잘못 | `VUID-Vk*CreateInfo-sType-sType` | pNext 체인에서 sType 오타 |
| `pNext`에 없는 구조 | `VUID-Vk*CreateInfo-pNext-pNext` | 알 수 없는 pNext 구조 |
| 접근 마스크 누락 | `VUID-VkBufferMemoryBarrier-srcAccessMask-...` | 배리어 access 0 |
| stage mismatch | `VUID-vkCmdPipelineBarrier-srcStageMask-...` | stage가 큐에서 미지원 |
| 서브리소스 범위 잘못 | `VUID-VkImageSubresourceRange-...` | aspect 0 또는 COLOR + PLANE 동시 |
| 영역 겹침 | `VUID-vkCmdCopyBuffer-pRegions-...` | src/dst 영역 메모리 겹침 |
| 면 정렬 | `VUID-VkBufferImageCopy-bufferOffset-...` | block size 배수 아님 |
| 함수 안에서 호출 | `VUID-renderpass` | 렌더 패스 안에서 copy/blit 호출 |

> **팁** VUID는 검증 메시지의 `pMessageIdName`에 들어가므로, 그걸 그대로 [Vulkan-Docs](https://github.com/KhronosGroup/Vulkan-Docs)나 `docs.vulkan.org`에서 검색하면 해당 valid usage 항목을 바로 찾을 수 있다.

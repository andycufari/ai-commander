---
name: esp32-lowpower
description: getting deep-sleep current down on ESP32 boards
---

Hold floating GPIOs low before `esp_deep_sleep_start()`, or the sensor LDO stays on.

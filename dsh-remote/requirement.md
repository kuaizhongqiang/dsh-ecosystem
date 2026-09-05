# 需求文档

## 项目简介

### dsh意义

- dsh代表deepseek harness ,仓库地址为https://github.com/deepseek-ai/deepseek-harness.git

### remote意义

- dsh 自带界面是一个web ui ，所以我们需要将dsh server本身运行在一个远程服务器上，通过一个公网地址访问
- 登录安全问题由cloudflare解决

## 环境描述

- 服务器
  - 运行环境：Ubuntu 
  - CPU：Intel i5-12600
  - 内存：16G
  - 硬盘：1T
- 网络：
  - IP: 无固定IP
  - TailScale：开发电脑与服务器连接
  - 路由：https://<DOMAIN>/

## 调试需求

- 1. 服务器拉取一个dsh项目
- 2. 调试服务器网关路由
- 3. 打开广域网网址，正确运行dsh web

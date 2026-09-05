# DEPRECATED(PM2 / 路线图 §8 11→7)

本包已并入 **dsh-media** 合并包(共享凭证与模式,--only 支持子集安装)。
按 PLAN §8「迁移与兼容」,本包保留一个 deprecated 版本周期。

## 迁移步骤

1. 安装新包:plugins/dsh-media-dsh-plugin/install.ps1(无需参数即含本包服务)
2. 清理本包:仓库根 uninstall-old.ps1(移除旧载荷与 cordis.patch.yml 旧节)
3. 重启 web 实例
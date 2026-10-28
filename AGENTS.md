# dsh-plugins-bridge

## 项目简介

该项目为 `DeepSeek Harness` 的插件，用于给 dsh 内部安装的其它插件一个向外的接口，使得外部的其它程序能够通过本地 HTTP 请求来获取其它插件的信息或者执行插件的功能。目的是让其它编辑器（例如 `Emacs`, `Vim`等）能够调用 dsh 的插件的功能。

## 必须遵守

该项目在 `docs/ARCHITECTURE.md` 文件中保存项目架构信息，在每次修改项目后必须对其进行更新。

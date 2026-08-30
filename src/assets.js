// 资产清单（v4 全外置版）
// 真实陀螺 PNG（images/tops）、UI 图标（images/icons）、元素角标（images/icons/icon-<el>.png）
// 均已外置为包内文件，运行时由 utils.prepSrc 从包路径（/images/...）加载。
// 真机稳定，且主包不再内嵌任何 base64 资源（体积从 ~1.27MB 降至数 KB）。
// 以下字段仅作「是否存在磁盘镜像」的占位；实际加载走文件路径回退（b64 为空 → prepSrc 取 /images）。
module.exports = {
  tops: [],
  els: {},
  icons: {}
};

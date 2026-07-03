# Explorer 谓词协议:12 个 predicate 的判定标准与反例

> repo-explorer / repo-fact-verifier 共用。原则:**谓词描述的是代码的真实运行语义,不是文本相似度**。每个谓词给出判定标准(什么算)与反例(什么不算——全部来自本 harness 真实误判史)。

## 结构类

### `imports` / `dynamic-imports`
- **算**:源文件中真实存在的 import/require/`import()` 语句,目标解析为仓库内文件或声明过的外部包。`dynamic-imports` 仅限运行时加载:`import()`、`require.context`、配置驱动的组件懒加载。
- **不算**:注释掉的 import;字符串里恰好长得像路径;alias 导入不确定指向时(写 openQuestion,让确定性解析器处理)。
- **注意**:目标写相对路径原文即可,解析交给 harness;不要自己猜 alias 展开结果。

### `contains`
- **算**:父组件 template 中真实渲染子组件(Vue template 标签、JSX 引用);文件内定义符号。
- **不算**:仅 import 但未在 template/渲染路径中使用(那是 `imports`);字符串提及组件名。

### `depends-on`
- **算**:manifest 声明的依赖;模块 A 的运行必须以 B 存在为前提且无更具体谓词可用。
- **不算**:能用 imports/calls/contains 表达的(优先用具体谓词)。

### `extends` / `implements`
- **算**:语言级继承/接口实现(class extends、implements、Vue extends/mixins 链)。
- **不算**:"风格像"、复制粘贴相似。

## 运行时类

### `routes-to`
- **算**:路由声明真实绑定页面/处理器:vue-router 的 `{ path, component }`、Spring 的 `@RequestMapping` 系列、express 的 `app.get(path, handler)`。subject 是 route 节点,object 是被绑定文件。
- **不算**(真实误判史):任意对象字面量的 `path:` 键(曾把 `static/code-map.json` 判成路由);i18n 文件里的路径字符串;面包屑/菜单配置(那是导航数据,除非它就是该项目的路由注册机制——要给出注册机制的证据)。

### `registers`
- **算**:全局注册行为:`Vue.component()`、`app.use()`、qiankun 生命周期导出、webpack UMD 挂载、路由守卫注册(`router.beforeEach`)。
- **不算**:普通函数调用;局部变量赋值。

### `calls`
- **算**:跨进程/跨服务调用:HTTP client 调用(axios/fetch 带真实 URL 或 API 常量)、RPC(Dubbo/Feign/Hessian)、MQ 生产消费。object 用 service 节点(URL 前缀、服务名、topic)。
- **不算**(真实误判史):日志/报错字符串里含 URL(曾把 console.error 的用法提示判成调用);工具函数内部互调(那不是服务边界);仅配置了 client 但没有调用点。
- **label 纪律**:object 的 label 用真实端点/服务名,禁止取"该行随便一个引号字符串"。

### `guarded-by`
- **算**:真实鉴权/拦截链:路由守卫中的权限判断、`v-hasPermission` 类指令的定义与使用、Java `@PreAuthorize`/Shiro filter、axios 拦截器中的 token/签名逻辑。**注意项目本地约定**:如 `checkPermission(...)`、`permissionIds` 这类项目自有函数/字段,只要证据显示它确实在做访问控制,就算。
- **不算**(真实误判史):`ant-design` 里的 "design" 含 "sign";`ignoreReadBeforeAssign` 之类标识符含 "sign";lock 文件里的依赖名;CSS/注释提及 auth。**判定依据是代码行为,不是子串命中**。

### `reads-from` / `writes-to`
- **算**:真实数据链路:后端的 SQL/ORM/缓存/topic 读写;前端的 sessionStorage/localStorage/cookie/vuex 持久化读写(object 用 datastore 节点,label 写真实存储名/键)。
- **不算**(真实误判史):`isSelect` 里的 "Select";变量名含 database/queue/topic;表单字段赋值(`formData.contactType = x` 不是写数据库)。

## 通用纪律

1. **证据即判据**:每条 fact 的 evidence 行必须让一个没看过上下文的人能复核出该谓词成立。做不到 → openQuestion。
2. **confidence 校准**:代码里直接可见 → 0.85-0.95(source: dynamic);需要一步推断(如"这个 axios 实例的 baseURL 来自这个常量") → 0.6-0.8(source: inferred);两步以上推断 → 不要当 fact。
3. **一事一边**:同一对 (subject, object) 有多种关系时分别建边,不要挑一个"最像的"。
4. **对端不在 repo 内**:calls/reads-from 的对端(外部服务、DB 实例)用 service/datastore 节点表达,并在 openQuestion 里标注"对端未在本仓库内确认"。

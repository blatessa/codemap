package xorm

type Engine struct{}
type Session struct{}

func NewEngine() *Engine { return &Engine{} }

func (*Engine) Where(q any, args ...any) *Session            { return nil }
func (*Engine) ID(id any) *Session                           { return nil }
func (*Engine) Table(t any) *Session                         { return nil }
func (*Engine) Insert(beans ...any) (int64, error)           { return 0, nil }
func (*Engine) Get(bean any) (bool, error)                   { return false, nil }
func (*Session) Where(q any, args ...any) *Session           { return nil }
func (*Session) ID(id any) *Session                          { return nil }
func (*Session) Table(t any) *Session                        { return nil }
func (*Session) SQL(q string, args ...any) *Session          { return nil }
func (*Session) Cols(cols ...string) *Session                { return nil }
func (*Session) Get(bean any) (bool, error)                  { return false, nil }
func (*Session) Find(beans any, cond ...any) error           { return nil }
func (*Session) Count(bean ...any) (int64, error)            { return 0, nil }
func (*Session) Update(bean any, cond ...any) (int64, error) { return 0, nil }
func (*Session) Delete(bean ...any) (int64, error)           { return 0, nil }
func (*Session) Insert(beans ...any) (int64, error)          { return 0, nil }

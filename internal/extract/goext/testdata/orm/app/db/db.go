// Package db wraps xorm the way many repos do: a repo interface over the
// engine, and helpers taking beans or type parameters.
package db

import "xorm.io/xorm"

type Engine interface {
	Insert(beans ...any) (int64, error)
	Get(bean any) (bool, error)
	Where(q any, args ...any) *xorm.Session
	ID(id any) *xorm.Session
}

var x = xorm.NewEngine()

func GetEngine() Engine { return x }

func Insert(beans ...any) error {
	_, err := GetEngine().Insert(beans...)
	return err
}

func GetByID[T any](id int64) (*T, error) {
	var bean T
	_, err := GetEngine().ID(id).Get(&bean)
	return &bean, err
}

func Find[T any](cond any) ([]*T, error) {
	sess := GetEngine().Where(cond)
	objects := make([]*T, 0, 10)
	return objects, sess.Find(&objects)
}

// DeleteByBean deletes rows matching a bean.
func DeleteByBean(bean any) error {
	_, err := GetEngine().Where(nil).Delete(bean)
	return err
}

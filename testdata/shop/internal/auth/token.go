package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// issueToken signs a 24-hour token. Tokens can't be revoked.
func (h *Handler) issueToken(u *User) string {
	exp := strconv.FormatInt(time.Now().Add(24*time.Hour).Unix(), 10)
	payload := u.ID + "." + exp
	return payload + "." + h.sign(payload)
}

func (h *Handler) parseToken(header string) (string, error) {
	tok := strings.TrimPrefix(header, "Bearer ")
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || !hmac.Equal([]byte(h.sign(parts[0]+"."+parts[1])), []byte(parts[2])) {
		return "", errors.New("invalid token")
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", errors.New("expired token")
	}
	return parts[0], nil
}

func (h *Handler) sign(s string) string {
	m := hmac.New(sha256.New, h.secret)
	m.Write([]byte(s))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
